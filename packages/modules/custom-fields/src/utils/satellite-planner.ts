import { MikroORM } from "@medusajs/framework/mikro-orm/core"
import {
  DatabaseSchema,
  PostgreSqlDriver,
} from "@medusajs/framework/mikro-orm/postgresql"
import {
  DALUtils,
  ModulesSdkUtils,
  normalizeMigrationSQL,
  toMikroOrmEntities,
} from "@medusajs/framework/utils"
import { DmlEntity } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"

import { ownerColumnName, satelliteTableName } from "./satellite"

export type SatelliteAction = {
  entity: string
  table: string
  action: "create" | "update" | "noop" | "notify"
  sql: string
  /**
   * Populated for `notify`: why it is not applied without confirmation.
   */
  warnings?: string[]
}

/**
 * Statements that can lose data, so they are never run without a human saying
 * so. Same list the link module uses, and it is what makes a *type* change
 * surface as a prompt: MikroORM emits `alter column` for one.
 */
const UNSAFE_SQL_COMMANDS = ["alter column", "drop column"]

/**
 * Columns the satellite manages itself, which the diff should leave alone.
 */
const IGNORED_COLUMNS = ["created_at", "updated_at", "deleted_at"]

/**
 * Keep only the statements naming the table this module owns.
 *
 * A hard blast-radius guard: whatever the generator produces, nothing can be
 * emitted against a table belonging to another module. Lifted from the link
 * module's planner, which is private to it.
 */
function pickTableRelatedCommands(table: string, sql: string): string {
  return sql
    .split(";")
    .filter((command) => {
      const cmd = command.trim()
      return (
        cmd.length &&
        cmd !== "set names 'utf8'" &&
        cmd.includes(`"${table}"`) &&
        !IGNORED_COLUMNS.some((column) => cmd.includes(`column "${column}"`))
      )
    })
    .map((command) => `${command.trim()};`)
    .join("\n")
}

async function tableExists(
  orm: MikroORM<PostgreSqlDriver>,
  table: string,
  schema: string
): Promise<boolean> {
  const rows = await orm.em
    .getConnection()
    .execute(
      `select 1 from information_schema.tables where table_name = ? and table_schema = ?`,
      [table, schema]
    )

  return !!(rows as unknown[])?.length
}

/**
 * The ownership record: one row per satellite table this module created,
 * mirroring the link planner's `link_module_migrations`
 * (`link-modules/src/migration/index.ts:98-109`). Ownership — not mere
 * existence — is what decides create-vs-update, what lets a pre-existing table
 * with a colliding name be refused instead of adopted and diffed, and what
 * makes a de-configured entity's satellite visible as an orphan rather than
 * leaking forever.
 */
export const TRACKING_TABLE = "custom_field_migrations"

async function ensureTrackingTable(
  orm: MikroORM<PostgreSqlDriver>,
  schema: string
): Promise<void> {
  await orm.em.getConnection().execute(`
    CREATE TABLE IF NOT EXISTS "${schema}"."${TRACKING_TABLE}" (
      id SERIAL PRIMARY KEY,
      table_name VARCHAR(255) NOT NULL UNIQUE,
      entity VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

async function getTrackedSatellites(
  orm: MikroORM<PostgreSqlDriver>,
  schema: string
): Promise<{ table_name: string; entity: string }[]> {
  return (await orm.em
    .getConnection()
    .execute(
      `select table_name, entity from "${schema}"."${TRACKING_TABLE}"`
    )) as { table_name: string; entity: string }[]
}

/**
 * The upgrade path, mirroring the link planner's
 * `ensureMigrationsTableUpToDate`: satellites created before the tracking
 * table existed are adopted into it — but only when the table's shape proves
 * it is ours (the owner id column plus the audit columns). A pre-existing
 * table that merely shares the name keeps failing the shape check and is
 * refused by the planner instead of silently diffed.
 */
async function adoptExistingSatellites(
  orm: MikroORM<PostgreSqlDriver>,
  schema: string,
  satellites: Map<string, DmlEntity<any, any>>,
  trackedTables: string[]
): Promise<void> {
  for (const entity of satellites.keys()) {
    const table = satelliteTableName(entity)

    if (trackedTables.includes(table)) {
      continue
    }

    const columns = (await orm.em
      .getConnection()
      .execute(
        `select column_name from information_schema.columns where table_schema = ? and table_name = ?`,
        [schema, table]
      )) as { column_name: string }[]

    if (!columns.length) {
      continue
    }

    const names = new Set(columns.map((column) => column.column_name))
    const expected = [
      ownerColumnName(entity),
      "created_at",
      "updated_at",
      "deleted_at",
    ]

    if (!expected.every((column) => names.has(column))) {
      continue
    }

    await orm.em
      .getConnection()
      .execute(
        `insert into "${schema}"."${TRACKING_TABLE}" (table_name, entity) values (?, ?) on conflict (table_name) do nothing`,
        [table, entity]
      )
    trackedTables.push(table)
  }
}

/**
 * Diff one satellite entity against the live schema.
 *
 * The satellite is a DML entity, so rather than hand-writing DDL and
 * hand-diffing it, this hands the entity to MikroORM and uses its schema
 * generator purely as a **SQL producer** — never as an executor. That is the
 * shape the link module already uses for tables it defines at runtime
 * (`link-modules/src/migration/index.ts:279`), and it matters for more than
 * code size: the entity becomes the single description of the table. When the
 * DDL was written by hand alongside the entity, the two drifted — `number`
 * built an `integer` property and a `numeric` column, and values came back as
 * strings.
 *
 * It also means type changes are detected for free. A hand-rolled diff on
 * column *names* cannot see one; the generator emits `alter column ... type`,
 * which lands in {@link UNSAFE_SQL_COMMANDS} and therefore in `notify`.
 */
export async function planSatellite(
  dbConfig: any,
  entity: string,
  satellite: DmlEntity<any, any>,
  trackedTables: string[]
): Promise<SatelliteAction> {
  const table = satelliteTableName(entity)
  const schema = dbConfig.schema || "public"

  const [mikroEntity] = toMikroOrmEntities([satellite])
  const orm: MikroORM<PostgreSqlDriver> =
    await DALUtils.mikroOrmCreateConnection(dbConfig, [mikroEntity], "")

  try {
    const generator = orm.getSchemaGenerator()
    const platform = orm.em.getPlatform()
    const connection = orm.em.getConnection()

    const exists = await tableExists(orm, table, schema)
    const tracked = trackedTables.includes(table)

    // A table this module has no ownership record for belongs to someone.
    // Adopting and diffing it would issue drop-column notifications against
    // their columns — the link planner silently adopts here; we refuse
    // loudly instead, with the manual way out named.
    if (exists && !tracked) {
      return {
        entity,
        table,
        action: "notify",
        sql: "",
        warnings: [
          `"${table}" already exists but was not created by the custom fields module. ` +
            `Rename the conflicting table, or take ownership deliberately by inserting ` +
            `its name into "${TRACKING_TABLE}".`,
        ],
      }
    }

    // Not tracked and absent — or tracked but dropped out-of-band: create,
    // recording ownership in the same execution.
    if (!exists) {
      const createSQL = normalizeMigrationSQL(
        await generator.getCreateSchemaSQL()
      )

      return {
        entity,
        table,
        action: "create",
        sql:
          `${createSQL}
` +
          `insert into "${schema}"."${TRACKING_TABLE}" (table_name, entity) ` +
          `values ('${table}', '${entity}') on conflict (table_name) do nothing;`,
      }
    }

    /**
     * @note `loadInformationSchema` mutates the schema passed as its first
     * argument.
     */
    const dbSchema = new DatabaseSchema(platform, schema)
    await platform
      .getSchemaHelper?.()
      ?.loadInformationSchema(dbSchema, connection, [
        { table_name: table, schema_name: schema },
      ])

    const sql = pickTableRelatedCommands(
      table,
      normalizeMigrationSQL(
        await generator.getUpdateSchemaSQL({ fromSchema: dbSchema })
      )
    )

    if (!sql.length) {
      return { entity, table, action: "noop", sql: "" }
    }

    const unsafe = UNSAFE_SQL_COMMANDS.filter((fragment) =>
      sql.match(new RegExp(fragment, "ig"))
    )

    if (!unsafe.length) {
      return { entity, table, action: "update", sql }
    }

    return {
      entity,
      table,
      action: "notify",
      sql,
      warnings: unsafe.map((fragment) =>
        fragment === "drop column"
          ? `"${table}" has a column with no matching definition. Dropping it deletes its data.`
          : `"${table}" has a column whose type no longer matches its definition. Converting it may fail, or may lose precision.`
      ),
    }
  } finally {
    await orm.close(true)
  }
}

export async function planSatellites(
  options: any,
  satellites: Map<string, DmlEntity<any, any>>
): Promise<SatelliteAction[]> {
  const dbConfig = ModulesSdkUtils.loadDatabaseConfig(
    Modules.CUSTOM_FIELDS,
    options
  )
  const schema = dbConfig.schema || "public"

  const orm: MikroORM<PostgreSqlDriver> =
    await DALUtils.mikroOrmCreateConnection(dbConfig, [], "")

  let tracked: { table_name: string; entity: string }[]
  let trackedTables: string[]
  try {
    await ensureTrackingTable(orm, schema)
    tracked = await getTrackedSatellites(orm, schema)
    trackedTables = tracked.map((row) => row.table_name)
    await adoptExistingSatellites(orm, schema, satellites, trackedTables)
  } finally {
    await orm.close(true)
  }

  const plans: SatelliteAction[] = []
  for (const [entity, satellite] of satellites) {
    plans.push(await planSatellite(dbConfig, entity, satellite, trackedTables))
  }

  // Ownership makes orphans visible: a tracked table whose entity is no
  // longer configured. Offered as a destructive action through the same
  // confirm-to-execute flow as any other data-losing statement — never
  // applied on its own.
  const configuredTables = new Set(
    [...satellites.keys()].map((entity) => satelliteTableName(entity))
  )

  for (const row of tracked) {
    if (configuredTables.has(row.table_name)) {
      continue
    }

    plans.push({
      entity: row.entity,
      table: row.table_name,
      action: "notify",
      sql:
        `drop table if exists "${schema}"."${row.table_name}";
` +
        `delete from "${schema}"."${TRACKING_TABLE}" where table_name = '${row.table_name}';`,
      warnings: [
        `"${row.table_name}" was created for "${row.entity}", which no longer has ` +
          `custom fields configured. Dropping it deletes its data.`,
      ],
    })
  }

  return plans
}

/**
 * Apply a plan. `notify` actions are skipped unless the caller has explicitly
 * promoted them to `update` after confirming what would happen.
 */
export async function executeSatellitePlan(
  knex: any,
  actions: SatelliteAction[]
): Promise<void> {
  for (const action of actions) {
    if (action.action === "noop" || action.action === "notify" || !action.sql) {
      continue
    }

    await knex.raw(action.sql)
  }
}
