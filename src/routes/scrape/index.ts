"use strict";

import { Request, Response, Router } from "express";
import { parse } from "url";
import bencode from "bencode";
import { parseQuery } from "../../utils";
import redis from "../../lib/redis";
import { blacklist } from "../../lib/store";

const router = Router();

async function getTorrentCounts(
  torrentKey: string,
): Promise<{ complete: number; incomplete: number } | null> {
  let complete = 0;
  let incomplete = 0;
  let hasPeers = false;
  const peerStream = redis.hscanStream(torrentKey, { count: 200 });

  for await (const chunk of peerStream) {
    for (let i = 1; i < chunk.length; i += 2) {
      const peerData = chunk[i];

      if (!peerData) continue;

      const peer = JSON.parse(peerData);
      hasPeers = true;

      if (peer.left === 0) complete++;
      else incomplete++;
    }
  }

  if (!hasPeers) return null;

  return { complete, incomplete };
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const { query } = parse(req.url ?? "", false);
    const params = parseQuery(query ?? undefined);

    const info_hashes = Array.isArray(params["info_hash"])
      ? params["info_hash"]
      : params["info_hash"]
        ? [params["info_hash"]]
        : [];

    const files: Record<string, any> = {};

    if (info_hashes.length > 0) {
      for (const raw_info_hash of info_hashes) {
        if (typeof raw_info_hash !== "string") continue;

        const info_hash_hex =
          raw_info_hash.length === 20
            ? Buffer.from(raw_info_hash, "binary").toString("hex").toLowerCase()
            : raw_info_hash.toLowerCase();

        if (blacklist.includes(info_hash_hex)) {
          res.set("Content-Type", "text/plain");
          res.send(
            bencode.encode({
              "failure reason":
                "This torrent is blacklisted due to take-down policy.",
            }),
          );
          return;
        }

        const torrentKey = `torrent:${info_hash_hex}`;
        const counts = await getTorrentCounts(torrentKey);

        if (counts) {
          files[raw_info_hash] = { ...counts, downloaded: 0 };
        }
      }
    } else {
      const keyStream = redis.scanStream({ match: "torrent:*", count: 500 });

      for await (const keys of keyStream) {
        for (const torrentKey of keys) {
          const info_hash_hex = torrentKey.replace("torrent:", "");

          if (blacklist.includes(info_hash_hex)) continue;
          const counts = await getTorrentCounts(torrentKey);

          if (counts) {
            let raw_info_hash = info_hash_hex;
            if (info_hash_hex.length === 40) {
              raw_info_hash = Buffer.from(info_hash_hex, "hex").toString(
                "binary",
              );
            }
            files[raw_info_hash] = { ...counts, downloaded: 0 };
          }
        }
      }
    }

    res.set("Content-Type", "text/plain");
    res.send(bencode.encode({ files }));
  } catch (error) {
    console.error("Scrape error:", error);
    res.status(500).send(
      bencode.encode({
        "failure reason": "Internal server error",
      }),
    );
  }
});

export default router;
