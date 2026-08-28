import Database from "better-sqlite3";
import { AccountStore } from "../dist/accounts/account-store.js";

const db = new Database(":memory:");
const store = new AccountStore(db);
const now = new Date().toISOString();
db.prepare(`INSERT INTO account_users
	(id,email,username,nickname,display_name,password_hash,role,account_group,status,created_at,updated_at)
	VALUES ('admin-test','admin@example.test','admin_test','Admin','Admin','x','admin','default','active',?,?)`)
	.run(now, now);

store.normalizeAdminGroup("admin", "default");
const normalized = store.getUserById("admin-test");
if (normalized?.group !== "admin" || normalized.quotaMbOverride !== null) {
	throw new Error(`admin group migration failed: ${JSON.stringify(normalized)}`);
}

store.updateUser("admin-test", { quotaMbOverride: 4096, retentionDaysOverride: 0 });
const updated = store.getUserById("admin-test");
if (updated?.quotaMbOverride !== 4096 || updated.retentionDaysOverride !== 0) {
	throw new Error(`account policy override failed: ${JSON.stringify(updated)}`);
}

console.log(JSON.stringify({
	group: updated.group,
	quotaMbOverride: updated.quotaMbOverride,
	retentionDaysOverride: updated.retentionDaysOverride,
}));
