"use strict";

import { Request, Response, Router } from "express";
import redis from "../../lib/redis";
import { blacklist } from "../../lib/store";

const router = Router();

router.get("/:infoHash", async (req: Request, res: Response) => {
  try {
    const infoHash = req.params.infoHash?.toLowerCase();

    if (!infoHash) {
      res.status(400).json({
        error: "Missing info hash",
      });
      return;
    }

    if (blacklist.includes(infoHash)) {
      res.status(403).json({
        error: "This torrent is blacklisted due to take-down policy.",
      });
      return;
    }

    const torrentKey = `torrent:${infoHash}`;
    const peerData = await redis.hvals(torrentKey);

    if (!peerData.length) {
      res.status(404).json({
        error: "Torrent not found",
      });
      return;
    }

    const peers = peerData.map((p) => JSON.parse(p));

    let seeders = 0;
    let leechers = 0;
    let uploaded = 0;
    let downloaded = 0;

    const clientMap: Record<string, number> = {};

    for (const peer of peers) {
      if (peer.left === 0) seeders++;
      else leechers++;

      uploaded += peer.uploaded || 0;
      downloaded += peer.downloaded || 0;

      const match = peer.peer_id?.match(/^-(.{2})/);
      const clientPrefix = match?.[1] || "??";

      clientMap[clientPrefix] = (clientMap[clientPrefix] || 0) + 1;
    }

    res.json({
      infoHash,
      totalPeers: peers.length,
      seeders,
      leechers,
      uploaded,
      downloaded,
      hasSeederAndLeecher: seeders > 0 && leechers > 0,
      clients: clientMap,
      peers: peers.map((peer) => ({
        peerId: peer.peer_id,
        ip: peer.ip,
        port: peer.port,
        uploaded: peer.uploaded,
        downloaded: peer.downloaded,
        left: peer.left,
        isSeeder: peer.left === 0,
        lastSeen: peer.lastSeen,
      })),
    });
  } catch (error) {
    console.error("Torrent endpoint error:", error);

    res.status(500).json({
      error: "Internal server error",
    });
  }
});

export default router;
