#!/usr/bin/env python3
"""Writes small synthetic GameCube disc images for the browser tests.

They have the shape of a disc (header, FST, the files the runtime checks) but
no game content: every file is a few bytes of filler behind the right magic.
Nothing from a real disc is used or needed.

  make_test_disc.py OUT_DIR  ->  OUT_DIR/synthetic-gmse01.iso   (accepted)
                                 OUT_DIR/synthetic-gale01.iso   (wrong game id)
                                 OUT_DIR/synthetic-gmse01.ciso  (CISO of the first)
                                 OUT_DIR/not-a-disc.iso         (random bytes)
"""
import os
import struct
import sys

MAGIC = 0xC2339F3D


def build_disc(game_id: bytes, title: bytes) -> bytes:
    files = {
        "data/nintendo.szs": b"Yaz0" + struct.pack(">I", 0x1000) + b"\0" * 8 + b"N" * 4080,
        "data/mario.szs": b"Yaz0" + struct.pack(">I", 0x2000) + b"\0" * 8 + b"M" * 8176,
        "data/scene/dolpic0.szs": b"Yaz0" + struct.pack(">I", 0x3000) + b"\0" * 8 + b"P" * 12272,
    }
    # FST: root, data/, data/nintendo.szs, data/mario.szs, data/scene/, data/scene/dolpic0.szs
    entries = []   # (is_dir, name, a, b) -- a/b filled below
    names = b""

    def name_off(n: str) -> int:
        nonlocal names
        off = len(names)
        names += n.encode() + b"\0"
        return off

    entries.append([1, 0, 0, 6])                         # root: next = count
    entries.append([1, name_off("data"), 0, 6])          # data: parent 0, next 6
    entries.append([0, name_off("nintendo.szs"), 0, 0])  # files: offset, size
    entries.append([0, name_off("mario.szs"), 0, 0])
    entries.append([1, name_off("scene"), 1, 6])         # scene: parent 1, next 6
    entries.append([0, name_off("dolpic0.szs"), 0, 0])
    file_entries = {2: "data/nintendo.szs", 3: "data/mario.szs", 5: "data/scene/dolpic0.szs"}

    dol_off = 0x4000
    dol = b"\0" * 0x100  # placeholder, not a DOL
    fst_off = 0x5000
    fst_size = len(entries) * 12 + len(names)
    data_off = 0x8000
    out = bytearray(data_off)
    pos = data_off
    for idx, path in file_entries.items():
        blob = files[path]
        entries[idx][2] = pos
        entries[idx][3] = len(blob)
        out += blob
        out += b"\0" * ((-len(out)) % 0x8000)
        pos = len(out)
    fst = b"".join(struct.pack(">III", (e[0] << 24) | e[1], e[2], e[3]) for e in entries) + names

    hdr = bytearray(0x440)
    hdr[0:6] = game_id
    hdr[6] = 0   # disc number
    hdr[7] = 0   # revision
    struct.pack_into(">I", hdr, 0x1C, MAGIC)
    hdr[0x20:0x20 + len(title)] = title
    struct.pack_into(">III", hdr, 0x420, dol_off, fst_off, fst_size)
    struct.pack_into(">I", hdr, 0x42C, fst_size)
    out[0:0x440] = hdr
    out[dol_off:dol_off + len(dol)] = dol
    out[fst_off:fst_off + fst_size] = fst
    return bytes(out)


def to_ciso(img: bytes, block: int = 0x8000) -> bytes:
    nblocks = (len(img) + block - 1) // block
    header = bytearray(0x8000)
    header[0:4] = b"CISO"
    struct.pack_into("<I", header, 4, block)
    body = bytearray()
    for i in range(nblocks):
        chunk = img[i * block:(i + 1) * block].ljust(block, b"\0")
        if any(chunk) or i == 0:
            header[8 + i] = 1
            body += chunk
    return bytes(header) + bytes(body)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    good = build_disc(b"GMSE01", b"SYNTHETIC TEST DISC (no game data)")
    with open(os.path.join(out, "synthetic-gmse01.iso"), "wb") as f:
        f.write(good)
    with open(os.path.join(out, "synthetic-gmse01.ciso"), "wb") as f:
        f.write(to_ciso(good))
    with open(os.path.join(out, "synthetic-gale01.iso"), "wb") as f:
        f.write(build_disc(b"GALE01", b"SYNTHETIC OTHER GAME"))
    with open(os.path.join(out, "not-a-disc.iso"), "wb") as f:
        f.write(os.urandom(0x10000))
    print(f"test discs written to {out}")


if __name__ == "__main__":
    main()
