"use strict";

import { Request, Response, Router } from "express";
import { parse } from "url";
import bencode from "bencode";
import { Peer, AnnounceResponse, defaultAnnounceInterval } from "../../types";
import { getIP, parseQuery } from "../../utils";
import { blacklist } from "../../lib/store";
import redis from "../../lib/redis";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const { query } = parse(req.url ?? "", false);
    const params = parseQuery(query ?? undefined);

    let raw_info_hash = params["info_hash"];
    if (Array.isArray(raw_info_hash)) raw_info_hash = raw_info_hash[0];

    let peer_id = params["peer_id"];
    if (Array.isArray(peer_id)) peer_id = peer_id[0];

    const port = parseInt(params["port"] as string, 10);

    if (
      !raw_info_hash ||
      typeof raw_info_hash !== "string" ||
      !peer_id ||
      typeof peer_id !== "string" ||
      isNaN(port) ||
      port <= 0 ||
      port > 65535
    ) {
      res.set("Content-Type", "text/plain");

      res.status(400).send(
        bencode.encode({
          "failure reason": "Missing or invalid required parameters",
        }),
      );

      return;
    }

    const info_hash_hex =
      raw_info_hash.length === 20
        ? Buffer.from(raw_info_hash, "binary").toString("hex").toLowerCase()
        : raw_info_hash.toLowerCase();

    if (blacklist.includes(info_hash_hex)) {
      res.set("Content-Type", "text/plain");

      res.status(403).send(
        bencode.encode({
          "failure reason":
            "This torrent is blacklisted due to take-down policy.",
        }),
      );

      return;
    }

    const uploaded = parseInt(params["uploaded"] as string, 10) || 0;
    const downloaded = parseInt(params["downloaded"] as string, 10) || 0;
    const left = parseInt(params["left"] as string, 10) || 0;
    const event = Array.isArray(params["event"])
      ? params["event"][0]
      : params["event"];
    const compact = params["compact"] === "1";

    const ip = getIP(req);
    const torrentKey = `torrent:${info_hash_hex}`;

    if (event === "stopped") {
      await redis.hdel(torrentKey, peer_id);
    } else {
      const peer: Peer = {
        peer_id,
        ip,
        port,
        uploaded,
        downloaded,
        left,
        lastSeen: Date.now(),
      };

      await redis.hset(torrentKey, peer_id, JSON.stringify(peer));
    }

    const swarmData = await redis.hvals(torrentKey);
    const swarm = swarmData.map((p) => JSON.parse(p) as Peer);

    if (swarm.length === 0) {
      await redis.del(torrentKey);
    }

    let seeders = 0;
    let leechers = 0;

    swarm.forEach((p) => {
      if (p.left === 0) seeders++;
      else leechers++;
    });

    const peerList = swarm.filter((p) => p.peer_id !== peer_id);

    const response: AnnounceResponse = {
      interval: defaultAnnounceInterval,
      complete: seeders,
      incomplete: leechers,
      peers: compact
        ? createCompactPeerList(peerList)
        : createDictionaryPeerList(peerList),
    };

    res.set("Content-Type", "text/plain");
    res.send(bencode.encode(response));
  } catch (error) {
    console.error("Announce error:", error);

    res.set("Content-Type", "text/plain");
    res.status(400).send(
      bencode.encode({
        "failure reason": "Internal tracker error",
      }),
    );
  }
});

function createCompactPeerList(peers: Peer[]): Buffer {
  const buffer = Buffer.alloc(peers.length * 6);

  peers.forEach((peer, i) => {
    const offset = i * 6;
    const ipParts = peer.ip.split(".").map(Number);

    for (let j = 0; j < 4; j++) {
      buffer[offset + j] = ipParts[j] || 0;
    }

    buffer[offset + 4] = (peer.port >> 8) & 0xff;
    buffer[offset + 5] = peer.port & 0xff;
  });

  return buffer;
}

function createDictionaryPeerList(
  peers: Peer[],
): Array<{ peer_id: string; ip: string; port: number }> {
  return peers.map((p) => ({
    peer_id: p.peer_id,
    ip: p.ip,
    port: p.port,
  }));
}

export default router;
