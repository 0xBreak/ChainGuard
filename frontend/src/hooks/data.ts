import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RELAYER_URL } from "../config";
import { NETS_READY, chainStats, createTail, lastMirrorAt, registryEntries, type ChainEvent } from "../lib/chainguard";

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => Promise.all(NETS_READY.map(chainStats)),
    refetchInterval: 2000,
  });
}

/** True once the element has scrolled near the viewport (stays true). */
export function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: "400px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/** Every flag on every chain. Heavy with a large registry, so callers enable it only when visible. */
export function useRegistry(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["registry"],
    queryFn: async () => (await Promise.all(NETS_READY.map(registryEntries))).flat(),
    refetchInterval: 12000,
    staleTime: 8000,
  });
}

export interface RelayerStatus {
  mode: string;
  relayer: string;
  now: number;
  chains: { key: string; chainId: number; head: string; lastPollAt: number; lastMirrorAt: number; mirrorsSent: number; queued: number; errors: number }[];
  recent: { account: string; from: string; to: string; status: string; round: number; txHash: string; at: number; latencyMs: number | null }[];
}

export function useRelayer() {
  return useQuery({
    queryKey: ["relayer"],
    queryFn: async (): Promise<RelayerStatus | null> => {
      try {
        if (!RELAYER_URL) return null; // public build: relayer runs on a schedule, status comes from the chains
        const r = await fetch(`${RELAYER_URL}/status`, { signal: AbortSignal.timeout(1500) });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    },
    refetchInterval: 1500,
  });
}

/** Live event stream from every chain. New events also refresh registry-backed queries. */
export function useFeed(limit = 80) {
  const qc = useQueryClient();
  const [events, setEvents] = useState<ChainEvent[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    let first = true;
    const tails = NETS_READY.map((n) => createTail(n));
    const tick = async () => {
      const batches = await Promise.all(
        tails.map((t) =>
          t().catch((e) => {
            console.warn("feed poll failed", e);
            return [] as ChainEvent[];
          }),
        ),
      );
      if (alive) setLoaded(true);
      const incoming = batches.flat().filter((e) => !seen.current.has(e.id));
      if (!alive || incoming.length === 0) return;
      incoming.forEach((e) => seen.current.add(e.id));
      if (seen.current.size > 5000) seen.current = new Set([...seen.current].slice(-1000)); // keep dedupe window bounded
      setEvents((prev) =>
        [...incoming, ...prev].sort((a, b) => (b.time ?? 0) - (a.time ?? 0) || b.logIndex - a.logIndex).slice(0, limit),
      );
      if (!first) {
        setFresh(new Set(incoming.map((e) => e.id)));
        qc.invalidateQueries({ queryKey: ["check"] });
        qc.invalidateQueries({ queryKey: ["timeline"] });
      }
      first = false;
    };
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await tick();
      if (alive) timer = setTimeout(loop, 1500);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [limit, qc]);

  return { events, fresh, loaded };
}

/** Last time each chain received a mirrored flag, read from logs. */
export function useLastMirror() {
  return useQuery({
    queryKey: ["lastMirror"],
    queryFn: async () => Object.fromEntries(await Promise.all(NETS_READY.map(async (n) => [n.key, await lastMirrorAt(n).catch(() => null)] as const))),
    refetchInterval: 30_000,
  });
}
