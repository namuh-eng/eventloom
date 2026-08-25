import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const defaultWranglerPath = join(repositoryRoot, "apps/api/wrangler.toml");
const migrationsDirectory = join(repositoryRoot, "apps/api/migrations");
const environments = ["local", "staging", "production"];
const placeholderIdPattern = /^00000000-0000-0000-0000-00000000000\d$/;
const sqlIdentifierSource = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)';
const dropTablePattern = new RegExp(`^DROP\\s+TABLE\\s+(${sqlIdentifierSource})$`, "i");
const createTablePattern = new RegExp(
  `^CREATE\\s+TABLE\\s+(${sqlIdentifierSource})\\s*\\(([\\s\\S]*)\\)\\s*(?:STRICT|WITHOUT\\s+ROWID)?$`,
  "i",
);
const snapshotTablePattern = new RegExp(
  `^CREATE\\s+TABLE\\s+(${sqlIdentifierSource})\\s+AS\\s+SELECT\\s+\\*\\s+FROM\\s+(${sqlIdentifierSource})$`,
  "i",
);
const restoreTablePattern = new RegExp(
  `^INSERT\\s+INTO\\s+(${sqlIdentifierSource})\\s+SELECT\\s+\\*\\s+FROM\\s+(${sqlIdentifierSource})$`,
  "i",
);
const deleteTablePattern = new RegExp(`^DELETE\\s+FROM\\s+(${sqlIdentifierSource})$`, "i");

function parseArguments(argv) {
  let environment = "local";
  let deployment = false;
  let configPath = defaultWranglerPath;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--environment") {
      environment = argv[index + 1];
      index += 1;
    } else if (argument === "--deployment") {
      deployment = true;
    } else if (argument === "--config") {
      configPath = resolve(repositoryRoot, argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!environments.includes(environment)) {
    throw new Error(`Environment must be one of: ${environments.join(", ")}`);
  }

  return { configPath, deployment, environment };
}

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) {
    throw new Error(message);
  }
}

function collectValues(source, key) {
  const pattern = new RegExp(`^${key}\\s*=\\s*"([^"]+)"$`, "gm");
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique across environments`);
  }
}

function splitSql(source, delimiter = ";") {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (quote !== null) {
      current += character;
      if (quote === "[" ? character === "]" : character === quote) {
        if (quote !== "[" && next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === "-" && next === "-") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      current += " ";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      current += " ";
      continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;

    if (character === delimiter && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function normalizeIdentifier(identifier) {
  const first = identifier[0];
  if (first === "`" || first === '"' || first === "[") {
    return identifier
      .slice(1, -1)
      .replaceAll(first === "[" ? "]]" : first.repeat(2), first === "[" ? "]" : first);
  }
  return identifier;
}

function indexesMatching(statements, pattern, predicate = () => true) {
  return statements.flatMap((statement, index) => {
    const match = pattern.exec(statement);
    return match && predicate(match) ? [{ index, match }] : [];
  });
}

function destructiveMigrationError(migration) {
  return new Error(`${migration} contains a destructive migration operation`);
}

export function validateMigrationSql(migration, sql) {
  const statements = splitSql(sql);
  const drops = indexesMatching(statements, dropTablePattern);
  const deletes = indexesMatching(statements, deleteTablePattern);
  const hasForeignKeysOff = statements.some((statement) =>
    /^PRAGMA\s+foreign_keys\s*(?:=|\()\s*(?:OFF|0)\s*\)?$/i.test(statement),
  );

  if (statements.some((statement) => /\b(?:DROP\s+COLUMN|TRUNCATE)\b/i.test(statement))) {
    throw destructiveMigrationError(migration);
  }
  const dropTableStatementCount = statements.filter((statement) =>
    /\bDROP\s+TABLE\b/i.test(statement),
  ).length;
  if (dropTableStatementCount !== drops.length) throw destructiveMigrationError(migration);
  const deleteTableStatementCount = statements.filter((statement) =>
    /\bDELETE\s+FROM\b/i.test(statement),
  ).length;
  if (deleteTableStatementCount !== deletes.length) throw destructiveMigrationError(migration);
  if (drops.length === 0 && deletes.length > 0) {
    throw destructiveMigrationError(migration);
  }

  if (drops.length > 0) {
    const migrationNumber = /^(\d{4})_/.exec(migration)?.[1];
    const snapshotPrefix = migrationNumber ? `_${migrationNumber}_` : null;
    const originalDrops = drops.filter(
      ({ match }) => !snapshotPrefix || !normalizeIdentifier(match[1]).startsWith(snapshotPrefix),
    );
    const expectedSnapshotTables = new Set(
      originalDrops.map(({ match }) => `${snapshotPrefix}${normalizeIdentifier(match[1])}`),
    );
    const snapshotDrops = drops.filter(({ match }) =>
      expectedSnapshotTables.has(normalizeIdentifier(match[1])),
    );
    const helperDrops = drops.filter(({ match }) => {
      const table = normalizeIdentifier(match[1]);
      return (
        snapshotPrefix && table.startsWith(snapshotPrefix) && !expectedSnapshotTables.has(table)
      );
    });
    for (const helperDrop of helperDrops) {
      const helperTable = normalizeIdentifier(helperDrop.match[1]);
      const matchingCreates = indexesMatching(
        statements,
        snapshotTablePattern,
        (match) => normalizeIdentifier(match[1]) === helperTable,
      );
      if (matchingCreates.length !== 1 || matchingCreates[0].index >= helperDrop.index) {
        throw destructiveMigrationError(migration);
      }
    }

    if (
      hasForeignKeysOff ||
      !snapshotPrefix ||
      originalDrops.length === 0 ||
      originalDrops.length !== snapshotDrops.length
    ) {
      throw destructiveMigrationError(migration);
    }
    for (const deletion of deletes) {
      const sourceTable = normalizeIdentifier(deletion.match[1]);
      const snapshotTable = `${snapshotPrefix}${sourceTable}`;
      const matchingSnapshots = indexesMatching(
        statements,
        snapshotTablePattern,
        (match) =>
          normalizeIdentifier(match[1]) === snapshotTable &&
          normalizeIdentifier(match[2]) === sourceTable,
      );
      const matchingRestores = indexesMatching(
        statements,
        restoreTablePattern,
        (match) =>
          normalizeIdentifier(match[1]) === sourceTable &&
          normalizeIdentifier(match[2]) === snapshotTable,
      );
      const matchingSnapshotDrops = [...snapshotDrops, ...helperDrops].filter(
        ({ match }) => normalizeIdentifier(match[1]) === snapshotTable,
      );
      if (
        matchingSnapshots.length !== 1 ||
        matchingRestores.length !== 1 ||
        matchingSnapshotDrops.length !== 1 ||
        matchingSnapshots[0].index >= deletion.index ||
        deletion.index >= matchingRestores[0].index ||
        matchingRestores[0].index >= matchingSnapshotDrops[0].index
      ) {
        throw destructiveMigrationError(migration);
      }
    }

    const snapshots = [];
    const creates = [];
    const restores = [];
    const rebuilds = new Map();
    for (const drop of originalDrops) {
      const sourceTable = normalizeIdentifier(drop.match[1]);
      const snapshotTable = `${snapshotPrefix}${sourceTable}`;
      const matchingSnapshots = indexesMatching(
        statements,
        snapshotTablePattern,
        (match) =>
          normalizeIdentifier(match[1]) === snapshotTable &&
          normalizeIdentifier(match[2]) === sourceTable,
      );
      const matchingCreates = indexesMatching(
        statements,
        createTablePattern,
        (match) => normalizeIdentifier(match[1]) === sourceTable,
      );
      const matchingRestores = indexesMatching(
        statements,
        restoreTablePattern,
        (match) =>
          normalizeIdentifier(match[1]) === sourceTable &&
          normalizeIdentifier(match[2]) === snapshotTable,
      );
      const matchingSnapshotDrops = snapshotDrops.filter(
        ({ match }) => normalizeIdentifier(match[1]) === snapshotTable,
      );

      if (
        matchingSnapshots.length !== 1 ||
        matchingCreates.length !== 1 ||
        matchingRestores.length !== 1 ||
        matchingSnapshotDrops.length !== 1
      ) {
        throw destructiveMigrationError(migration);
      }

      snapshots.push(matchingSnapshots[0]);
      creates.push(matchingCreates[0]);
      restores.push(matchingRestores[0]);
      rebuilds.set(sourceTable, {
        create: matchingCreates[0],
        drop,
        restore: matchingRestores[0],
      });
    }

    const phaseIsOrdered =
      Math.max(...snapshots.map(({ index }) => index)) <
        Math.min(...originalDrops.map(({ index }) => index)) &&
      Math.max(...originalDrops.map(({ index }) => index)) <
        Math.min(...creates.map(({ index }) => index)) &&
      Math.max(...creates.map(({ index }) => index)) <
        Math.min(...restores.map(({ index }) => index)) &&
      Math.max(...restores.map(({ index }) => index)) <
        Math.min(...snapshotDrops.map(({ index }) => index));

    if (!phaseIsOrdered) throw destructiveMigrationError(migration);

    const referencePattern = new RegExp(`\\bREFERENCES\\s+(${sqlIdentifierSource})`, "gi");
    for (const child of rebuilds.values()) {
      for (const match of child.create.match[2].matchAll(referencePattern)) {
        const parentTable = normalizeIdentifier(match[1]);
        const parent = rebuilds.get(parentTable);
        if (
          parent &&
          parent !== child &&
          !(
            child.drop.index < parent.drop.index &&
            parent.create.index < child.create.index &&
            parent.restore.index < child.restore.index
          )
        ) {
          throw destructiveMigrationError(migration);
        }
      }
    }
  }

  if (
    drops.length === 0 &&
    !statements.some((statement) => /^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(statement))
  ) {
    throw new Error(`${migration} must enable foreign keys`);
  }
}

export function validateMigrationOrdinals(migrations) {
  const seenFilenames = new Set();
  const seenOrdinals = new Set();
  for (const migration of migrations) {
    if (seenFilenames.has(migration)) {
      throw new Error(`Migration filename ${migration} is duplicated`);
    }
    seenFilenames.add(migration);
    const ordinal = /^(\d{4})_/u.exec(migration)?.[1];
    if (ordinal === undefined) {
      throw new Error(`Migration filename ${migration} has no four-digit ordinal`);
    }
    if (seenOrdinals.has(ordinal)) {
      throw new Error(`Migration ordinal ${ordinal} is duplicated`);
    }
    seenOrdinals.add(ordinal);
  }
}

function validateMigrations() {
  const migrations = readdirSync(migrationsDirectory)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort();

  if (migrations.length === 0) {
    throw new Error("At least one ordered D1 migration is required");
  }

  validateMigrationOrdinals(migrations);
  for (const migration of migrations) {
    const sql = readFileSync(join(migrationsDirectory, migration), "utf8");
    validateMigrationSql(migration, sql);
  }

  return migrations;
}

function validateWrangler(source, options) {
  if (/^account_id\s*=/m.test(source)) {
    throw new Error("Wrangler must take the Cloudflare account from CLOUDFLARE_ACCOUNT_ID");
  }
  requirePattern(
    source,
    /^workers_dev = false$/m,
    "The top-level local Worker must disable workers.dev",
  );
  requirePattern(
    source,
    /^main = "src\/infrastructure\/cloudflare\/worker\.ts"$/m,
    "Wrangler must use the Cloudflare infrastructure entrypoint",
  );
  requirePattern(
    source,
    /^new_sqlite_classes = \["AgendaCoordinator"\]$/m,
    "AgendaCoordinator requires a Durable Object migration",
  );

  if (/^(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\s*=/m.test(source)) {
    throw new Error("Secrets must be provider-managed and cannot appear in wrangler.toml vars");
  }

  const appEnvironments = collectValues(source, "APP_ENV");
  if (appEnvironments.join(",") !== environments.join(",")) {
    throw new Error("APP_ENV must define local, staging, and production exactly once");
  }

  const origins = collectValues(source, "WEB_ORIGIN");
  if (
    origins.length !== 3 ||
    !origins[0].startsWith("http://127.0.0.1:") ||
    origins.slice(1).some((origin) => !origin.startsWith("https://"))
  ) {
    throw new Error("Only local may use HTTP; staging and production origins must use HTTPS");
  }

  for (const binding of ["DB", "AGENDA_COORDINATOR", "PRIVATE_FILES", "OUTBOX_QUEUE"]) {
    const count = collectValues(
      source,
      binding === "AGENDA_COORDINATOR" ? "name" : "binding",
    ).filter((value) => value === binding).length;
    if (count !== 3) {
      throw new Error(`${binding} must be bound once in every environment`);
    }
  }

  const databaseNames = collectValues(source, "database_name");
  const bucketNames = collectValues(source, "bucket_name");
  const queueNames = [...new Set(collectValues(source, "queue"))];
  const databaseIds = collectValues(source, "database_id");
  const migrationDirectories = collectValues(source, "migrations_dir");

  for (const [label, values] of [
    ["D1 database names", databaseNames],
    ["R2 bucket names", bucketNames],
    ["Queue names", queueNames],
    ["D1 database IDs", databaseIds],
  ]) {
    if (values.length !== 3) {
      throw new Error(`${label} must have one value per environment`);
    }
    assertUnique(values, label);
  }
  if (
    migrationDirectories.length !== environments.length ||
    migrationDirectories.some((value) => value !== "migrations")
  ) {
    throw new Error("Every D1 binding must use the reviewed apps/api/migrations directory");
  }

  for (const [index, environment] of environments.entries()) {
    for (const [label, values] of [
      ["D1 database", databaseNames],
      ["R2 bucket", bucketNames],
      ["Queue", queueNames],
    ]) {
      if (!values[index].endsWith(`-${environment}`)) {
        throw new Error(`${label} name must end with -${environment}`);
      }
    }
  }

  if (options.deployment) {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID must be supplied before deployment");
    }
    const selectedId = databaseIds[environments.indexOf(options.environment)];
    if (placeholderIdPattern.test(selectedId)) {
      throw new Error(
        `${options.environment} D1 database_id is unprovisioned; replace it before deployment`,
      );
    }
    const expectedId = process.env.D1_DATABASE_ID?.trim();
    if (!expectedId) {
      throw new Error("D1_DATABASE_ID must be supplied before deployment");
    }
    if (selectedId !== expectedId) {
      throw new Error(
        `${options.environment} generated D1 database_id does not match D1_DATABASE_ID`,
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const wrangler = readFileSync(options.configPath, "utf8");
    validateWrangler(wrangler, options);
    const migrations = validateMigrations();
    process.stdout.write(
      `${JSON.stringify({
        valid: true,
        environment: options.environment,
        deploymentReady: options.deployment,
        migrations,
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown validation failure";
    process.stderr.write(`${JSON.stringify({ valid: false, error: message })}\n`);
    process.exitCode = 1;
  }
}
