#!/usr/bin/env python3
"""Explicit Lorana Tales database and resource-layout migration tool.

Dry-run is the default. Add --execute only after reviewing the printed plan.
PostgreSQL operations require Python 3.11+ and ``pip install psycopg[binary]``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Iterable

MAIN_TABLES = [
    "log_records", "log_payloads", "account_users", "account_sessions", "account_devices",
    "account_verification_codes", "editor_projects", "editor_project_shares",
    "account_effect_folders", "account_effect_presets", "effect_preset_shares",
    "account_audit_log", "account_risk_events",
]
RESOURCE_TABLES = ["resource_objects", "resource_sources"]
BOOLEAN_COLUMNS = {
    "archived", "must_change_password", "tutorial_prompt_seen", "manual_playback_hint_seen",
    "tutorial_playback_coach_seen", "recording_guide_seen", "legacy_link_hint_seen",
}
BIGINT_COLUMNS = {
    "created_at_ms", "updated_at_ms", "expires_at_ms", "consumed_at_ms", "last_used_at_ms",
    "stored_bytes", "encoded_bytes", "compressed_bytes", "decoded_bytes", "byte_size", "last_accessed_at_ms",
    "last_seen_at_ms", "log_id",
}
RESOURCE_ID_RE = __import__("re").compile(r"^[a-f0-9]{64}\.[a-z0-9]{1,8}$")
MARKER = ".lorana-resource-layout-v2"

SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS log_records(id INTEGER PRIMARY KEY AUTOINCREMENT,public_key TEXT NOT NULL UNIQUE,access_password TEXT NOT NULL DEFAULT '',password_hash TEXT NOT NULL,name TEXT NOT NULL,client TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',uploader_ip TEXT NOT NULL DEFAULT 'unknown',uniform_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,message_count INTEGER NOT NULL DEFAULT 0,stored_bytes INTEGER NOT NULL DEFAULT 0,encoded_bytes INTEGER NOT NULL DEFAULT 0,compressed_bytes INTEGER NOT NULL DEFAULT 0,decoded_bytes INTEGER NOT NULL DEFAULT 0,decode_error TEXT NOT NULL DEFAULT '',payload_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS log_payloads(log_id INTEGER PRIMARY KEY REFERENCES log_records(id) ON DELETE CASCADE,stored_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,username TEXT NOT NULL UNIQUE COLLATE NOCASE,nickname TEXT NOT NULL DEFAULT '',author_signature TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',display_name TEXT NOT NULL DEFAULT '',password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',account_group TEXT NOT NULL DEFAULT 'default',quota_mb_override INTEGER,retention_days_override INTEGER,status TEXT NOT NULL DEFAULT 'active',ban_reason TEXT NOT NULL DEFAULT '',ban_until TEXT NOT NULL DEFAULT '',must_change_password INTEGER NOT NULL DEFAULT 0,tutorial_prompt_seen INTEGER NOT NULL DEFAULT 0,manual_playback_hint_seen INTEGER NOT NULL DEFAULT 0,tutorial_playback_coach_seen INTEGER NOT NULL DEFAULT 0,recording_guide_seen INTEGER NOT NULL DEFAULT 0,legacy_link_hint_seen INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,csrf_hash TEXT NOT NULL,device_hash TEXT NOT NULL DEFAULT '',ip_prefix_hash TEXT NOT NULL DEFAULT '',user_agent_hash TEXT NOT NULL DEFAULT '',created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account_devices(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,ip_prefix_hash TEXT NOT NULL,user_agent_hash TEXT NOT NULL,created_at_ms INTEGER NOT NULL,last_used_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account_verification_codes(id TEXT PRIMARY KEY,email TEXT NOT NULL COLLATE NOCASE,purpose TEXT NOT NULL,code_hash TEXT NOT NULL,ip_prefix_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,consumed_at_ms INTEGER);
CREATE TABLE IF NOT EXISTS editor_projects(id TEXT PRIMARY KEY,user_id TEXT REFERENCES account_users(id) ON DELETE SET NULL,title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,document_blob BLOB NOT NULL,source_key TEXT NOT NULL DEFAULT '',source_revision TEXT NOT NULL DEFAULT '',source_secret_cipher TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_activity_at TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS editor_project_shares(token TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE REFERENCES editor_projects(id) ON DELETE CASCADE,created_by TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,created_at TEXT NOT NULL,expiry_mode TEXT NOT NULL DEFAULT 'project',expires_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS account_effect_folders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_effect_presets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,name TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'screen',folder_id TEXT NOT NULL DEFAULT '',preset_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS effect_preset_shares(code TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,preset_json TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_risk_events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL DEFAULT '',ip_prefix_hash TEXT NOT NULL DEFAULT '',event TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resource_objects(resource_id TEXT PRIMARY KEY,relative_path TEXT NOT NULL UNIQUE,category TEXT NOT NULL,mime TEXT NOT NULL,byte_size INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,last_accessed_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resource_sources(source_hash TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resource_objects(resource_id) ON DELETE CASCADE,last_seen_at_ms INTEGER NOT NULL);
"""

POSTGRES_SCHEMA = SQLITE_SCHEMA.replace("BLOB", "BYTEA").replace("INTEGER PRIMARY KEY AUTOINCREMENT", "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY").replace(" COLLATE NOCASE", "")
for _boolean_column in BOOLEAN_COLUMNS:
    POSTGRES_SCHEMA = POSTGRES_SCHEMA.replace(f"{_boolean_column} INTEGER NOT NULL DEFAULT 0", f"{_boolean_column} BOOLEAN NOT NULL DEFAULT false")
for _bigint_column in BIGINT_COLUMNS:
    POSTGRES_SCHEMA = POSTGRES_SCHEMA.replace(f"{_bigint_column} INTEGER", f"{_bigint_column} BIGINT")


class Db:
    def __init__(self, driver: str, location: str, *, must_exist: bool = False):
        self.driver = driver
        if driver == "sqlite":
            sqlite_path = Path(location).resolve()
            if must_exist and not sqlite_path.is_file(): raise SystemExit(f"SQLite source does not exist: {sqlite_path}")
            existed = sqlite_path.exists()
            if not must_exist: sqlite_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.conn = sqlite3.connect(str(sqlite_path))
            if not existed and os.name == "posix": sqlite_path.chmod(0o600)
            self.conn.execute("PRAGMA foreign_keys=ON")
        else:
            try:
                import psycopg
            except ImportError as exc:
                raise SystemExit("PostgreSQL migration requires: python -m pip install 'psycopg[binary]'") from exc
            self.conn = psycopg.connect(location)

    def execute(self, sql: str, params: Iterable[Any] = ()):
        marker = "?" if self.driver == "sqlite" else "%s"
        if marker == "%s":
            sql = sql.replace("?", "%s")
        return self.conn.execute(sql, tuple(params))

    def executemany(self, sql: str, rows: list[tuple[Any, ...]]) -> None:
        if self.driver == "postgres":
            with self.conn.cursor() as cursor: cursor.executemany(sql.replace("?", "%s"), rows)
        else:
            self.conn.executemany(sql, rows)

    def tables(self) -> set[str]:
        sql = "SELECT name FROM sqlite_master WHERE type='table'" if self.driver == "sqlite" else "SELECT tablename FROM pg_tables WHERE schemaname='public'"
        return {str(row[0]) for row in self.execute(sql).fetchall()}

    def columns(self, table: str) -> list[str]:
        if self.driver == "sqlite":
            return [str(row[1]) for row in self.execute(f'PRAGMA table_info("{table}")').fetchall()]
        return [str(row[0]) for row in self.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=? ORDER BY ordinal_position", (table,)).fetchall()]

    def count(self, table: str) -> int:
        return int(self.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0])

    def close(self):
        self.conn.close()


def create_schema(db: Db, tables: list[str]) -> None:
    statements = POSTGRES_SCHEMA if db.driver == "postgres" else SQLITE_SCHEMA
    wanted = set(tables)
    for statement in statements.split(";"):
        statement = statement.strip()
        if not statement:
            continue
        name = statement.split("CREATE TABLE IF NOT EXISTS ", 1)[1].split("(", 1)[0].strip() if "CREATE TABLE IF NOT EXISTS" in statement else ""
        if name in wanted:
            db.execute(statement)


def resolve_location(value: str) -> str:
    if value.startswith("env:"):
        name = value[4:]
        resolved = os.environ.get(name, "")
        if not resolved: raise SystemExit(f"environment variable is empty: {name}")
        return resolved
    return value


def migrate_db(args: argparse.Namespace, tables: list[str]) -> None:
    source_location = resolve_location(args.source)
    target_location = resolve_location(args.target)
    if args.source_driver == args.target_driver:
        same_location = (
            Path(source_location).resolve() == Path(target_location).resolve()
            if args.source_driver == "sqlite"
            else source_location == target_location
        )
        if same_location: raise SystemExit("source and target database must differ")
    if args.execute and args.target_driver == "sqlite" and Path(target_location).resolve().exists():
        raise SystemExit("SQLite destination must not already exist; migration never overwrites a database file")
    source = Db(args.source_driver, source_location, must_exist=args.source_driver == "sqlite")
    target: Db | None = None
    try:
        available = source.tables()
        selected = [table for table in tables if table in available]
        print(f"source={args.source_driver} target={args.target_driver} tables={len(selected)} execute={args.execute}")
        for table in selected:
            print(f"  {table}: {source.count(table)} rows")
        if not args.execute:
            print("DRY RUN: add --execute to create and copy into a new SQLite file or empty PostgreSQL destination")
            return
        target = Db(args.target_driver, target_location)
        create_schema(target, selected)
        for table in selected:
            if target.count(table):
                raise RuntimeError(f"destination table is not empty: {table}")
        for table in selected:
            columns = [column for column in source.columns(table) if column in set(target.columns(table))]
            placeholders = ",".join("?" for _ in columns)
            names = ",".join(f'"{column}"' for column in columns)
            cursor = source.execute(f'SELECT {names} FROM "{table}"')
            copied = 0
            while rows := cursor.fetchmany(args.batch_size):
                converted = []
                for row in rows:
                    values = list(row)
                    for index, column in enumerate(columns):
                        if column in BOOLEAN_COLUMNS:
                            values[index] = bool(values[index]) if target.driver == "postgres" else int(bool(values[index]))
                    converted.append(tuple(values))
                target.executemany(f'INSERT INTO "{table}" ({names}) VALUES ({placeholders})', converted)
                copied += len(converted)
            print(f"  copied {table}: {copied}")
        if target.driver == "postgres":
            for table in ("log_records", "account_audit_log", "account_risk_events"):
                if table in selected:
                    target.execute("SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT max(id) FROM " + table + "), 1), true)", (table,))
        target.conn.commit()
    except Exception:
        if target is not None: target.conn.rollback()
        raise
    finally:
        source.close()
        if target is not None: target.close()


def category_for(resource_id: str, image_category: str) -> tuple[str, str]:
    ext = resource_id.rsplit(".", 1)[-1]
    if ext in {"png", "jpg", "jpeg", "webp", "gif", "avif"}: return image_category, mimetypes.types_map.get(f".{ext}", "image/webp")
    if ext in {"mp3", "ogg", "wav", "aac", "amr", "silk"}: return "cq-audio", mimetypes.types_map.get(f".{ext}", "audio/ogg")
    return "files", mimetypes.types_map.get(f".{ext}", "application/octet-stream")


def verify_resource(entry: Path, resource_id: str, max_bytes: int) -> int:
    if entry.is_symlink(): raise RuntimeError(f"symbolic links are not accepted: {entry}")
    if entry.stat().st_size > max_bytes: raise RuntimeError(f"resource exceeds --max-file-mb: {entry}")
    digest = hashlib.sha256(); decoded_bytes = 0
    if entry.name.endswith(".br"):
        try: import brotli
        except ImportError as exc: raise SystemExit("Compressed legacy resources require: python -m pip install brotli") from exc
        decoder = brotli.Decompressor()
        with entry.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                output = decoder.process(chunk); decoded_bytes += len(output)
                if decoded_bytes > max_bytes: raise RuntimeError(f"decoded resource exceeds --max-file-mb: {entry}")
                digest.update(output)
        if not decoder.is_finished(): raise RuntimeError(f"truncated Brotli resource: {entry}")
    else:
        with entry.open("rb") as stream:
            while chunk := stream.read(1024 * 1024): decoded_bytes += len(chunk); digest.update(chunk)
    if digest.hexdigest() != resource_id.split(".", 1)[0]: raise RuntimeError(f"hash mismatch: {entry}")
    return entry.stat().st_size


def migrate_resources(args: argparse.Namespace) -> None:
    source, target = Path(args.source_dir).resolve(), Path(args.target_dir).resolve()
    if source == target: raise SystemExit("source-dir and target-dir must differ; migration is copy-only")
    if source in target.parents or target in source.parents: raise SystemExit("source-dir and target-dir must not contain one another")
    if Path(args.source_dir).is_symlink() or Path(args.target_dir).is_symlink(): raise SystemExit("source-dir and target-dir must not be symbolic links")
    if target.exists() and any(target.iterdir()): raise SystemExit("target-dir must be absent or empty")
    if not source.is_dir(): raise SystemExit(f"source-dir does not exist: {source}")
    old_index = source / "source-index.json"
    if old_index.exists() and old_index.stat().st_size > 16 * 1024 * 1024: raise SystemExit("source-index.json exceeds the 16 MiB safety limit")
    index = json.loads(old_index.read_text("utf-8")) if old_index.exists() else {}
    if not isinstance(index, dict): raise SystemExit("source-index.json must contain an object")
    candidates = []
    for entry in source.iterdir():
        raw_name = entry.name[:-3] if entry.name.endswith(".br") else entry.name
        if entry.is_file() and RESOURCE_ID_RE.fullmatch(raw_name): candidates.append((entry, raw_name))
    print(f"legacy resources={len(candidates)} source aliases={len(index)} execute={args.execute}")
    if not args.execute:
        print(f"DRY RUN: add --execute to copy, verify and create the v2 {args.index_driver} resource index")
        return
    target.mkdir(parents=True, exist_ok=False, mode=0o700) if not target.exists() else None
    if os.name == "posix": target.chmod(0o700)
    if args.index_driver == "postgres" and not args.index: raise SystemExit("--index is required when --index-driver=postgres")
    index_location = args.index or args.index_sqlite or str(target / "resource-index.sqlite")
    if args.index_driver == "sqlite":
        resolved_index = Path(index_location).resolve()
        if resolved_index == source or source in resolved_index.parents: raise SystemExit("SQLite resource index must not be created inside the legacy source directory")
        resolved_index.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = Db(args.index_driver, resolve_location(index_location)); create_schema(db, RESOURCE_TABLES)
    if any(db.count(table) for table in RESOURCE_TABLES): raise SystemExit("destination resource index must be empty")
    now = int(time.time() * 1000)
    try:
        for entry, resource_id in candidates:
            stored_size = verify_resource(entry, resource_id, args.max_file_mb * 1024 * 1024)
            category, mime = category_for(resource_id, args.legacy_image_category)
            relative = Path(category) / resource_id[:2] / entry.name
            destination = target / relative; destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(entry, destination)
            if os.name == "posix": destination.chmod(0o600)
            stat = entry.stat()
            db.execute("INSERT INTO resource_objects(resource_id,relative_path,category,mime,byte_size,created_at_ms,last_accessed_at_ms) VALUES(?,?,?,?,?,?,?)", (resource_id, relative.as_posix(), category, mime, stored_size, int(stat.st_ctime * 1000), int(stat.st_mtime * 1000)))
        migrated_ids = {resource_id for _, resource_id in candidates}
        for source_hash, resource_id in index.items():
            if isinstance(source_hash, str) and isinstance(resource_id, str) and resource_id in migrated_ids:
                db.execute("INSERT INTO resource_sources(source_hash,resource_id,last_seen_at_ms) VALUES(?,?,?) ON CONFLICT(source_hash) DO NOTHING", (source_hash, resource_id, now))
        db.conn.commit(); marker = target / MARKER; marker.write_text("lorana-resource-layout=2\n", "utf-8")
        if os.name == "posix": marker.chmod(0o600)
        print(f"copied and verified {len(candidates)} resources; source was not modified")
    except Exception:
        db.conn.rollback(); raise
    finally:
        db.close()


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    for name, tables in (("database", MAIN_TABLES), ("resource-index", RESOURCE_TABLES)):
        p = sub.add_parser(name); p.set_defaults(func=lambda a, t=tables: migrate_db(a, t))
        p.add_argument("--source-driver", choices=("sqlite", "postgres"), required=True); p.add_argument("--target-driver", choices=("sqlite", "postgres"), required=True)
        p.add_argument("--source", required=True, help="SQLite file path or PostgreSQL URL"); p.add_argument("--target", required=True, help="SQLite file path or PostgreSQL URL")
        p.add_argument("--batch-size", type=lambda value: max(1, min(100, int(value))), default=10, help="Rows per copy batch; keep small for large project blobs")
        p.add_argument("--execute", action="store_true")
    p = sub.add_parser("resources"); p.set_defaults(func=migrate_resources)
    p.add_argument("--source-dir", required=True); p.add_argument("--target-dir", required=True)
    p.add_argument("--index-driver", choices=("sqlite", "postgres"), default="sqlite"); p.add_argument("--index", help="SQLite path, PostgreSQL URL, or env:VARIABLE")
    p.add_argument("--index-sqlite", help="Deprecated alias for --index with SQLite")
    p.add_argument("--max-file-mb", type=lambda value: max(1, min(1024, int(value))), default=64)
    p.add_argument("--legacy-image-category", choices=("cq-images", "avatars"), default="cq-images", help="Old hashed index cannot distinguish QQ avatars from CQ images")
    p.add_argument("--execute", action="store_true")
    return root


def main() -> int:
    args = parser().parse_args(); args.func(args); return 0


if __name__ == "__main__":
    try: raise SystemExit(main())
    except KeyboardInterrupt: raise SystemExit(130)
