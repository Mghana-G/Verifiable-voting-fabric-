#!/usr/bin/env python3
"""
Voter registry generator.

Usage:
    python3 generate.py --count 12000 --seed 169774 [--out registry.db]

The seed (student admission number 169774) makes the voter_id sequence
reproducible.  Salts use Python's secrets module (cryptographically random)
and are stored in the database; re-running the script on an existing DB is
idempotent — existing rows are kept unchanged.

NOTE: The Phase 3 spec request specified --seed 169776; the correct admission
number per IMPLEMENTATION_BRIEF.md and MASTER_PLAN.md is 169774.  Use 169774
for a reproducible registry that matches the thesis documentation.
"""
import argparse
import hashlib
import os
import secrets
import sqlite3
import sys

from faker import Faker


def build_db(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.execute("""
        CREATE TABLE IF NOT EXISTS voters (
            voter_id TEXT PRIMARY KEY,
            salt     TEXT NOT NULL,
            hash     TEXT NOT NULL
        )
    """)
    con.execute("CREATE INDEX IF NOT EXISTS idx_hash ON voters (hash)")
    con.commit()
    return con


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic voter registry")
    parser.add_argument("--count", type=int, required=True, help="Number of voters to generate")
    parser.add_argument("--seed",  type=int, required=True, help="Faker seed (use admission number 169774)")
    parser.add_argument("--out",   default=os.path.join(os.path.dirname(__file__), "registry.db"),
                        help="Output SQLite path (default: registry.db beside this script)")
    args = parser.parse_args()

    Faker.seed(args.seed)
    fake = Faker()

    con = build_db(args.out)
    existing = con.execute("SELECT COUNT(*) FROM voters").fetchone()[0]
    if existing >= args.count:
        print(f"registry.db already has {existing} rows — nothing to do.", flush=True)
        con.close()
        return

    inserted = 0
    skipped  = 0
    batch: list[tuple[str, str, str]] = []

    for i in range(args.count):
        voter_id = fake.unique.numerify("KE########")
        salt     = secrets.token_hex(16)
        h        = hashlib.sha256((voter_id + salt).encode()).hexdigest()
        batch.append((voter_id, salt, h))

        if len(batch) >= 1000:
            cur = con.executemany("INSERT OR IGNORE INTO voters VALUES (?, ?, ?)", batch)
            inserted += cur.rowcount
            skipped  += len(batch) - cur.rowcount
            con.commit()
            batch.clear()
            print(f"  {inserted:,} inserted …", end="\r", flush=True)

    if batch:
        cur = con.executemany("INSERT OR IGNORE INTO voters VALUES (?, ?, ?)", batch)
        inserted += cur.rowcount
        skipped  += len(batch) - cur.rowcount
        con.commit()

    total = con.execute("SELECT COUNT(*) FROM voters").fetchone()[0]
    con.close()
    print(f"\nDone: {inserted:,} inserted, {skipped:,} skipped — {total:,} rows total in {args.out}")


if __name__ == "__main__":
    main()
