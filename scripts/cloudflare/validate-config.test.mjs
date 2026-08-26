import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateMigrationOrdinals, validateMigrationSql } from "./validate-config.mjs";

const migrationsDirectory = new URL("../../apps/api/migrations/", import.meta.url);
const migration0020 = readFileSync(
  new URL(
    "../../apps/api/migrations/0020_self_hostable_communication_senders.sql",
    import.meta.url,
  ),
  "utf8",
);

const safeDependencyRebuild = `
CREATE TABLE _0099_parents AS SELECT * FROM parents;
CREATE TABLE _0099_children AS SELECT * FROM children;
DROP TABLE children;
DROP TABLE parents;
CREATE TABLE parents (
  id text PRIMARY KEY NOT NULL
) STRICT;
CREATE TABLE children (
  id text PRIMARY KEY NOT NULL,
  parent_id text NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES parents(id)
) STRICT;
INSERT INTO parents SELECT * FROM _0099_parents;
INSERT INTO children SELECT * FROM _0099_children;
DROP TABLE _0099_children;
DROP TABLE _0099_parents;
`;
const safeSelfReferenceRebuild = `
CREATE TABLE _0099_nodes AS SELECT * FROM nodes;
DROP TABLE nodes;
CREATE TABLE nodes (
  id text PRIMARY KEY NOT NULL,
  parent_id text,
  FOREIGN KEY (parent_id) REFERENCES nodes(id)
) STRICT;
INSERT INTO nodes SELECT * FROM _0099_nodes;
DROP TABLE _0099_nodes;
`;
const safePreservationHelperRebuild = safeDependencyRebuild
  .replace(
    "CREATE TABLE _0099_children AS SELECT * FROM children;",
    "CREATE TABLE _0099_children AS SELECT * FROM children;\nCREATE TABLE _0099_preserve_children AS SELECT * FROM children;",
  )
  .replace(
    "DROP TABLE _0099_children;",
    "DROP TABLE _0099_preserve_children;\nDROP TABLE _0099_children;",
  );

function assertDestructive(sql) {
  assert.throws(
    () => validateMigrationSql("0099_test.sql", sql),
    /0099_test\.sql contains a destructive migration operation/,
  );
}

test("accepts the reviewed 0020 full dependency-graph rebuild", () => {
  assert.doesNotThrow(() =>
    validateMigrationSql("0020_self_hostable_communication_senders.sql", migration0020),
  );
});

test("accepts every checked-in ordered D1 migration", () => {
  const migrations = readdirSync(migrationsDirectory)
    .filter((entry) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(entry))
    .sort();

  assert.notEqual(migrations.length, 0);
  assert.doesNotThrow(() => validateMigrationOrdinals(migrations));
  for (const migration of migrations) {
    const sql = readFileSync(new URL(migration, migrationsDirectory), "utf8");
    assert.doesNotThrow(() => validateMigrationSql(migration, sql), migration);
  }
});

test("rejects duplicate migration ordinals even when filenames differ", () => {
  assert.throws(
    () => validateMigrationOrdinals(["0036_evaluation_export_jobs.sql", "0036_other.sql"]),
    /Migration ordinal 0036 is duplicated/u,
  );
});

test("accepts a migration-scoped snapshot rebuild in dependency-safe phase order", () => {
  assert.doesNotThrow(() => validateMigrationSql("0099_test.sql", safeDependencyRebuild));
});
test("accepts a snapshot-backed delete that is restored before helper cleanup", () => {
  assert.doesNotThrow(() =>
    validateMigrationSql(
      "0099_test.sql",
      safeDependencyRebuild.replace(
        "DROP TABLE children;",
        "DELETE FROM children;\nDROP TABLE children;",
      ),
    ),
  );
  assertDestructive(
    safeDependencyRebuild.replace(
      "DROP TABLE children;",
      "DELETE FROM audit_log;\nDROP TABLE children;",
    ),
  );
});
test("accepts a migration-scoped self-referencing snapshot rebuild", () => {
  assert.doesNotThrow(() => validateMigrationSql("0099_test.sql", safeSelfReferenceRebuild));
});
test("accepts a migration-scoped preservation helper with an exact source snapshot", () => {
  assert.doesNotThrow(() => validateMigrationSql("0099_test.sql", safePreservationHelperRebuild));
  assertDestructive(
    safePreservationHelperRebuild.replace(
      "CREATE TABLE _0099_preserve_children AS SELECT * FROM children;\n",
      "",
    ),
  );
});

test("rejects incomplete or lossy snapshot rebuilds", () => {
  assertDestructive(
    safeDependencyRebuild.replace("CREATE TABLE _0099_children AS SELECT * FROM children;\n", ""),
  );
  assertDestructive(
    safeDependencyRebuild.replace(
      "INSERT INTO children SELECT * FROM _0099_children;\n",
      "INSERT INTO children (id) SELECT id FROM _0099_children;\n",
    ),
  );
  assertDestructive(safeDependencyRebuild.replace("DROP TABLE _0099_children;\n", ""));
  assertDestructive(`PRAGMA foreign_keys = OFF;\n${safeDependencyRebuild}`);
  assertDestructive(`PRAGMA foreign_keys(0);\n${safeDependencyRebuild}`);
});

test("rejects dependency-unsafe drop, recreate, and restore order", () => {
  assertDestructive(
    safeDependencyRebuild.replace(
      "DROP TABLE children;\nDROP TABLE parents;",
      "DROP TABLE parents;\nDROP TABLE children;",
    ),
  );
  assertDestructive(
    safeDependencyRebuild.replace(
      /CREATE TABLE parents \(([\s\S]*?)\) STRICT;\nCREATE TABLE children \(([\s\S]*?)\) STRICT;/,
      "CREATE TABLE children ($2) STRICT;\nCREATE TABLE parents ($1) STRICT;",
    ),
  );
  assertDestructive(
    safeDependencyRebuild.replace(
      "INSERT INTO parents SELECT * FROM _0099_parents;\nINSERT INTO children SELECT * FROM _0099_children;",
      "INSERT INTO children SELECT * FROM _0099_children;\nINSERT INTO parents SELECT * FROM _0099_parents;",
    ),
  );
});

test("rejects arbitrary destructive migration operations", () => {
  for (const destructiveSql of [
    "DROP TABLE widgets;",
    "DROP TABLE IF EXISTS widgets;",
    "ALTER TABLE widgets DROP COLUMN name;",
    "TRUNCATE TABLE widgets;",
    "DELETE FROM widgets;",
  ]) {
    assertDestructive(`${destructiveSql}\nPRAGMA foreign_keys = ON;`);
  }
});
test("rejects conditional and aliased deletes standalone and beside a valid rebuild", () => {
  for (const deleteStatement of [
    "DELETE FROM parents WHERE id = 'parent-1';",
    "DELETE FROM parents AS parent;",
  ]) {
    assertDestructive(`${deleteStatement}\nPRAGMA foreign_keys = ON;`);
    assertDestructive(`${safeDependencyRebuild}\n${deleteStatement}`);
  }
});

test("rejects additional destructive SQL beside an otherwise safe rebuild", () => {
  assertDestructive(`${safeDependencyRebuild}\nDROP TABLE audit_log;`);
  assertDestructive(`${safeDependencyRebuild}\nDROP TABLE IF EXISTS audit_log;`);
  assertDestructive(`${safeDependencyRebuild}\nDELETE FROM parents;`);
});
