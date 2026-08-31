#!/usr/bin/env python3
"""Low-memory SQLite and legacy-resource migration smoke checks."""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import migrate_storage as migration  # noqa: E402


def verify_database(root: Path) -> None:
    source = root / "source.sqlite"
    target = root / "target.sqlite"
    database = migration.Db("sqlite", str(source))
    migration.create_schema(database, migration.MAIN_TABLES)
    database.execute(
        """INSERT INTO log_records(
            public_key,access_password,password_hash,name,client,note,uploader_ip,uniform_id,
            created_at,updated_at,created_at_ms,updated_at_ms,message_count,stored_bytes,
            encoded_bytes,compressed_bytes,decoded_bytes,decode_error,payload_sha256
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        ("key", "pw", "hash", "title", "test", "", "127.0.0.1", "u", "2026-01-01", "2026-01-01", 1, 1, 0, 2, 2, 2, 2, "", "sum"),
    )
    database.execute("INSERT INTO log_payloads(log_id,stored_json) VALUES(?,?)", (1, "{}"))
    database.conn.commit()
    database.close()

    dry_target = root / "dry-run-must-not-exist.sqlite"
    migration.migrate_db(
        argparse.Namespace(
            source_driver="sqlite",
            source=str(source),
            target_driver="sqlite",
            target=str(dry_target),
            batch_size=10,
            execute=False,
        ),
        migration.MAIN_TABLES,
    )
    assert not dry_target.exists()

    migration.migrate_db(
        argparse.Namespace(
            source_driver="sqlite",
            source=str(source),
            target_driver="sqlite",
            target=str(target),
            batch_size=10,
            execute=True,
        ),
        migration.MAIN_TABLES,
    )
    check = sqlite3.connect(target)
    try:
        assert check.execute("SELECT count(*) FROM log_records").fetchone()[0] == 1
        assert check.execute("SELECT stored_json FROM log_payloads").fetchone()[0] == "{}"
        if os.name == "posix": assert target.stat().st_mode & 0o777 == 0o600
    finally:
        check.close()


def verify_resources(root: Path) -> None:
    source = root / "legacy"
    target = root / "resources"
    index_path = root / "indexes" / "resource-index.sqlite"
    source.mkdir()
    content = b"lorana-resource-smoke"
    resource_id = f"{hashlib.sha256(content).hexdigest()}.bin"
    (source / resource_id).write_bytes(content)
    source_hash = hashlib.sha256(b"https://example.invalid/a").hexdigest()
    (source / "source-index.json").write_text(json.dumps({source_hash: resource_id}), encoding="utf-8")

    migration.migrate_resources(
        argparse.Namespace(
            source_dir=str(source),
            target_dir=str(target),
            index_driver="sqlite",
            index=str(index_path),
            index_sqlite=None,
            max_file_mb=1,
            legacy_image_category="cq-images",
            execute=True,
        )
    )
    check = sqlite3.connect(index_path)
    try:
        category, relative_path = check.execute("SELECT category,relative_path FROM resource_objects").fetchone()
        assert category == "files" and relative_path.startswith("files/")
        assert check.execute("SELECT count(*) FROM resource_sources").fetchone()[0] == 1
        assert check.execute("SELECT last_seen_at_ms FROM resource_sources").fetchone()[0] > 2_147_483_647
        assert (target / migration.MARKER).is_file()
        assert (target / relative_path).read_bytes() == content
        assert (source / resource_id).read_bytes() == content
        if os.name == "posix":
            assert target.stat().st_mode & 0o777 == 0o700
            assert index_path.stat().st_mode & 0o777 == 0o600
            assert (target / relative_path).stat().st_mode & 0o777 == 0o600
            assert (target / migration.MARKER).stat().st_mode & 0o777 == 0o600
    finally:
        check.close()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="lorana-storage-migration-") as temporary:
        root = Path(temporary)
        verify_database(root)
        verify_resources(root)
    print("SQLite database and legacy resource migration smoke checks passed.")


if __name__ == "__main__":
    main()
