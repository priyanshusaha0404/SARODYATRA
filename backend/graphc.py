"""Sarodyatra · graphc.py — a compact routing graph.

The OpenStreetMap graph (data/graph.npz) keeps every vertex of every road: ~545 000 nodes, three in four of them
only shape points in the middle of a street. Searching that graph costs ~0.15 s per full Dijkstra on a laptop —
and ten times more on a small cloud server (Render free: 0.1 CPU).

Here every chain of shape points between two junctions becomes ONE edge (same road id, same oneway rule, same
road class), so routes are found on a graph ~4× smaller. Each chain keeps its vertices in order, so the drawn route
and the turn-by-turn road names are exactly the same as before.

Built once and saved as data/graph_c.npz (python scripts/build_graph_c.py, or automatically on first start).
"""
import numpy as np

VERSION = 2


def _swap(f):
    """oneway bits seen from the other end of an edge: 4 (only u→v) ⇄ 8 (only v→u)"""
    return ((f & 4) << 1) | ((f & 8) >> 1)


def contract(lon, lat, u, v, length, rid, flags):
    N, E = len(lon), len(u)
    u = np.asarray(u, np.int64); v = np.asarray(v, np.int64)
    flags = np.asarray(flags, np.int64)
    ends = np.r_[u, v]
    deg = np.bincount(ends, minlength=N)
    order = np.argsort(ends, kind="stable")
    inc_ptr = np.r_[0, np.cumsum(deg)]
    inc_edge = order % E                            # incidence → edge id

    # a vertex can be folded into its street when it joins exactly two different edges of the same road,
    # same class / access bits and the same oneway direction when walked through
    keep = np.ones(N, bool)
    d2 = np.nonzero(deg == 2)[0]
    e1, e2 = inc_edge[inc_ptr[d2]], inc_edge[inc_ptr[d2] + 1]
    f1, f2 = flags[e1], flags[e2]
    dir1 = np.where(v[e1] == d2, f1 & 12, _swap(f1 & 12))    # e1 walked into the vertex
    dir2 = np.where(u[e2] == d2, f2 & 12, _swap(f2 & 12))    # e2 walked out of it
    ok = (e1 != e2) & (rid[e1] == rid[e2]) & ((f1 & ~12) == (f2 & ~12)) & (dir1 == dir2)
    keep[d2[ok]] = False

    U, V, L, F = u.tolist(), v.tolist(), np.asarray(length, np.float64).tolist(), flags.tolist()
    R = np.asarray(rid).tolist()
    IP, IE = inc_ptr.tolist(), inc_edge.tolist()
    K = keep.tolist()
    seen = [False] * E
    cu, cv, clen, crid, cfl, ptr, seq, cum = [], [], [], [], [], [0], [], []

    def walk_from(k, e):
        cur, ec, tot = k, e, 0.0
        f0 = F[e] & 12 if U[e] == k else _swap(F[e] & 12)
        seq.append(k); cum.append(0.0)
        while True:
            seen[ec] = True
            nxt = V[ec] if U[ec] == cur else U[ec]
            tot += L[ec]
            seq.append(nxt); cum.append(tot)
            if K[nxt]:
                break
            a = IE[IP[nxt]]
            ec = IE[IP[nxt] + 1] if a == ec else a
            cur = nxt
        cu.append(k); cv.append(nxt); clen.append(tot); crid.append(R[e])
        cfl.append((F[e] & ~12) | f0); ptr.append(len(seq))

    def sweep(nodes):
        for k in nodes:
            for i in range(IP[k], IP[k + 1]):
                e = IE[i]
                if not seen[e]:
                    walk_from(k, e)

    sweep(np.nonzero(keep)[0].tolist())
    # rings with no junction at all (a closed lane): keep one vertex of each and sweep again
    while True:
        rest = [e for e in range(E) if not seen[e]]
        if not rest:
            break
        n = U[rest[0]]
        K[n] = True; keep[n] = True
        sweep([n])

    kept = np.nonzero(keep)[0]
    kid = np.full(N, -1, np.int64); kid[kept] = np.arange(len(kept))
    return {"version": np.int64(VERSION), "src_edges": np.int64(E), "src_nodes": np.int64(N),
            "kept": kept.astype(np.int32),
            "cu": kid[np.asarray(cu)].astype(np.int32), "cv": kid[np.asarray(cv)].astype(np.int32),
            "clen": np.asarray(clen, np.float64), "crid": np.asarray(crid, np.int32), "cflags": np.asarray(cfl, np.uint8),
            "ptr": np.asarray(ptr, np.int64), "seq": np.asarray(seq, np.int32), "cum": np.asarray(cum, np.float32)}


def load(data_dir):
    """the compact graph + the original vertex coordinates; builds data/graph_c.npz when missing or stale"""
    g = np.load(data_dir / "graph.npz")
    lon, lat = g["lon"], g["lat"]
    path = data_dir / "graph_c.npz"
    c = None
    if path.exists():
        try:
            z = np.load(path)
            if int(z["version"]) == VERSION and int(z["src_edges"]) == len(g["u"]) and int(z["src_nodes"]) == len(lon):
                c = {k: z[k] for k in z.files}
        except Exception:
            c = None
    if c is None:
        c = contract(lon, lat, g["u"], g["v"], g["length"], g["rid"], g["flags"])
        try:
            np.savez_compressed(path, **c)
        except OSError:
            pass
    c["lon"], c["lat"] = lon, lat
    return c
