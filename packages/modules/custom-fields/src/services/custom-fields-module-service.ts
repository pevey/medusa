import {
  Context,
  InternalModuleDeclaration,
  ModuleJoinerConfig,
} from "@medusajs/framework/types"
import {
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
  MedusaError,
  MikroOrmBaseRepository,
  Modules,
  defineJoinerConfig,
  isDefined,
  isObject,
  pluralize,
} from "@medusajs/framework/utils"
import {
  CustomFieldDefinition,
  CustomFieldType,
  SatelliteSnapshotRecord,
} from "@/types"
import {
  getConfiguredEntities,
  getDefinitions,
  getSatellites,
  ownerColumnName,
  satelliteEntityName,
  satelliteTableName,
} from "@/utils"

type InjectedDependencies = {
  manager: any
}

let joinerConfig: ModuleJoinerConfig | undefined
let joinerConfigSignature: string | undefined

export default class CustomFieldsModuleService {
  protected readonly baseRepository_: MikroOrmBaseRepository

  constructor(
    { manager }: InjectedDependencies,
    protected readonly moduleDeclaration?: InternalModuleDeclaration
  ) {
    // The module owns no static models, so nothing registers a repository for
    // it. One is still needed: `@InjectManager` and `@InjectTransactionManager`
    // resolve `getFreshManager()` and `transaction()` from `baseRepository_`.
    this.baseRepository_ = new MikroOrmBaseRepository({ manager })
  }

  /**
   * The knex handle for the active context.
   *
   * Values are read and written with raw SQL against the satellite table, so
   * the transaction context has to be picked up explicitly — an EntityManager
   * inside a transaction exposes it separately from the plain connection. Same
   * pattern the DAL uses internally (`mikro-orm-repository.ts:457`).
   */
  protected knex(sharedContext: Context = {}): any {
    const manager = this.baseRepository_.getActiveManager<any>(sharedContext)
    const knex = manager?.getTransactionContext?.() ?? manager?.getKnex?.()

    if (!knex) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Custom fields require a SQL connection to read or write values"
      )
    }

    return knex
  }

  /**
   * Satellite entities are built by this module's connection loader from
   * configuration, so they are not on disk under `src/models` and the
   * auto-generated joiner config would miss them. Declaring the config here
   * instead puts them in the entity graph, which is what makes their columns
   * selectable and filterable through `query.graph`.
   *
   * Recomputed rather than cached once: `Module()` calls this while the module
   * is still being defined, before any satellite exists, and the module system
   * calls it again after loaders have run. Memoized on the satellite set so the
   * repeated calls are cheap and the returned object is stable.
   */
  __joinerConfig(): ModuleJoinerConfig {
    const satellites = [...getSatellites().values()]
    const signature = satellites.map((s) => s.name).join(",")

    if (!joinerConfig || joinerConfigSignature !== signature) {
      joinerConfigSignature = signature
      joinerConfig = defineJoinerConfig(Modules.CUSTOM_FIELDS, {
        models: satellites,
      })
    }

    return joinerConfig
  }

  /**
   * Read rows from an entity's satellite table.
   *
   * The joiner calls `list<Entity>` / `listAndCount<Entity>` on a module's
   * service when it traverses into it. Those methods normally come from
   * `MedusaService`, which cannot be used here: satellites are built from
   * configuration at load time, long after the class is defined. They are
   * attached to the prototype instead — see `registerSatelliteMethods`.
   */
  @InjectManager()
  async listSatellite(
    entity: string,
    filters: Record<string, any> = {},
    config: SatelliteListConfig = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<Record<string, unknown>[]> {
    const definitions = getDefinitions(entity)

    if (!definitions.length) {
      return []
    }

    const owner = ownerColumnName(entity)
    const knex = this.knex(sharedContext)

    const columns = new Set<string>([owner])
    for (const field of config.select ?? []) {
      if (field === owner || definitions.some((d) => d.key === field)) {
        columns.add(field)
      }
    }
    if (!config.select?.length) {
      definitions.forEach((d) => columns.add(d.key))
    }

    let query = this.filteredQuery_(knex, entity, definitions, filters).select([
      ...columns,
    ])

    for (const [key, direction] of Object.entries(config.order ?? {})) {
      if (key !== owner && !definitions.some((d) => d.key === key)) {
        continue
      }
      query = query.orderBy(
        key,
        `${direction}`.toLowerCase().startsWith("desc") ? "desc" : "asc"
      )
    }

    if (config.take) {
      query = query.limit(config.take)
    }
    if (config.skip) {
      query = query.offset(config.skip)
    }

    return await query
  }

  /**
   * `listSatellite` with the total the filters match, counted independently of
   * the page — the page alone cannot say, and reporting its length as the
   * total lies whenever `take` is in play.
   */
  @InjectManager()
  async listAndCountSatellite(
    entity: string,
    filters: Record<string, any> = {},
    config: SatelliteListConfig = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<[Record<string, unknown>[], number]> {
    const definitions = getDefinitions(entity)

    if (!definitions.length) {
      return [[], 0]
    }

    const rows = await this.listSatellite(entity, filters, config, sharedContext)

    if (!config.take && !config.skip) {
      return [rows, rows.length]
    }

    const knex = this.knex(sharedContext)
    const [{ count }] = await this.filteredQuery_(
      knex,
      entity,
      definitions,
      filters
    ).count({ count: "*" })

    return [rows, Number(count)]
  }

  /**
   * The satellite's base query: soft-deletes excluded, filters applied.
   * Filter keys that are neither the owner column nor a definition are
   * ignored; operator objects are translated — see {@link applyFilter}.
   */
  protected filteredQuery_(
    knex: any,
    entity: string,
    definitions: CustomFieldDefinition[],
    filters: Record<string, any>
  ): any {
    const owner = ownerColumnName(entity)

    let query = knex(satelliteTableName(entity)).whereNull("deleted_at")

    for (const [key, value] of Object.entries(filters ?? {})) {
      if (key !== owner && !definitions.some((d) => d.key === key)) {
        continue
      }
      query = applyFilter(entity, query, key, value)
    }

    return query
  }

  /**
   * Attach the `list*` / `listAndCount*` methods the joiner expects, one pair
   * per configured entity, using the same names `defineJoinerConfig` derives.
   */
  static registerSatelliteMethods(entities: string[]): void {
    const proto = CustomFieldsModuleService.prototype as any

    for (const entity of entities) {
      const suffix = pluralize(satelliteEntityName(entity))

      proto[`list${suffix}`] = function (
        filters: any,
        config: any,
        sharedContext?: Context
      ) {
        return this.listSatellite(entity, filters, config, sharedContext)
      }

      proto[`listAndCount${suffix}`] = function (
        filters: any,
        config: any,
        sharedContext?: Context
      ) {
        return this.listAndCountSatellite(entity, filters, config, sharedContext)
      }
    }
  }

  /**
   * The resolved definitions for one entity, in stable key order.
   */
  listDefinitions(entity: string): CustomFieldDefinition[] {
    return getDefinitions(entity)
  }

  /**
   * Every entity that has at least one custom field configured.
   */
  listConfiguredEntities(): string[] {
    return getConfiguredEntities()
  }

  /**
   * Read one owner's custom field values.
   */
  @InjectManager()
  async getValues(
    entity: string,
    ownerId: string,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<Record<string, unknown>> {
    const definitions = getDefinitions(entity)

    if (!definitions.length) {
      return {}
    }

    const knex = this.knex(sharedContext)
    const { rows } = await knex.raw(
      `select * from "${satelliteTableName(entity)}" where "${ownerColumnName(
        entity
      )}" = ? and deleted_at is null limit 1`,
      [ownerId]
    )

    const row = rows?.[0]
    if (!row) {
      return {}
    }

    return Object.fromEntries(
      definitions.map((definition) => [definition.key, row[definition.key]])
    )
  }

  /**
   * Validate and persist one owner's custom field values.
   *
   * Every write of custom field values goes through here, whatever the caller —
   * an API request, a workflow step, a subscriber, a seed script. That is what
   * makes a required field hold outside HTTP, which is the gap the
   * `additional_data` path leaves open.
   */
  @InjectTransactionManager()
  async setValues(
    entity: string,
    ownerId: string,
    values: Record<string, unknown>,
    { partial = false }: { partial?: boolean } = {},
    @MedusaContext() sharedContext: Context = {}
  ): Promise<Record<string, unknown>> {
    const validated = this.validateValues(entity, values, { partial })

    if (!Object.keys(validated).length) {
      return {}
    }

    await this.upsertRow_(this.knex(sharedContext), entity, ownerId, validated)

    return validated
  }

  protected async upsertRow_(
    knex: any,
    entity: string,
    ownerId: string,
    values: Record<string, unknown>
  ): Promise<void> {
    const table = satelliteTableName(entity)
    const owner = ownerColumnName(entity)

    const columns = Object.keys(values)
    const placeholders = columns.map(() => "?").join(", ")
    const quoted = columns.map((c) => `"${c}"`).join(", ")
    const updates = columns
      .map((c) => `"${c}" = excluded."${c}"`)
      .concat(`"updated_at" = now()`)

    // Writing values for an owner resurrects a soft-deleted row — stated
    // values should be readable. `restoreSnapshot` overrides this by carrying
    // `deleted_at` explicitly, to put back exactly what was there.
    if (!columns.includes("deleted_at")) {
      updates.push(`"deleted_at" = null`)
    }

    await knex.raw(
      `insert into "${table}" ("${owner}", ${quoted}) values (?, ${placeholders})
       on conflict ("${owner}") do update set ${updates.join(", ")}`,
      [ownerId, ...columns.map((c) => values[c] as any)]
    )
  }

  /**
   * Capture owners' satellite rows as they stand, ahead of a write, so
   * {@link restoreSnapshot} can put back exactly that state if the surrounding
   * workflow compensates.
   *
   * Distinguishes a missing row from a row of nulls — `getValues` cannot,
   * since both read back as empty — because the two have to be undone
   * differently: a row that never existed must be deleted, not overwritten
   * with nulls.
   */
  @InjectManager()
  async snapshotValues(
    entity: string,
    ownerIds: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<SatelliteSnapshotRecord[]> {
    const definitions = getDefinitions(entity)

    if (!definitions.length || !ownerIds.length) {
      return ownerIds.map((id) => ({ id, existed: false, values: {} }))
    }

    const knex = this.knex(sharedContext)
    const owner = ownerColumnName(entity)

    // No `deleted_at` filter — the column is captured instead: the snapshot
    // exists to restore exact state, including soft-deletion, not to read
    // values the way `getValues` does.
    const rows: Record<string, unknown>[] = await knex(
      satelliteTableName(entity)
    )
      .select([owner, "deleted_at", ...definitions.map((d) => d.key)])
      .whereIn(owner, ownerIds)

    const byId = new Map(rows.map((row) => [row[owner] as string, row]))

    return ownerIds.map((id) => {
      const row = byId.get(id)

      return {
        id,
        existed: !!row,
        deleted_at: (row?.deleted_at as SatelliteSnapshotRecord["deleted_at"]) ?? null,
        values: row
          ? Object.fromEntries(definitions.map((d) => [d.key, row[d.key]]))
          : {},
      }
    })
  }

  /**
   * Put satellite rows back to a snapshotted state. This is the compensation
   * entry point — "restore" in the Medusa sense of un-soft-deleting is
   * {@link restoreValues}.
   *
   * Not `setValues`: restoring prior state is not a user write, so it does not
   * go through `validateValues`. A stored row may legitimately fail current
   * validation — a null in a column whose definition was tightened to
   * `required` after the row was written — and re-validating it would fail the
   * compensation this method exists to serve.
   */
  @InjectTransactionManager()
  async restoreSnapshot(
    entity: string,
    snapshot: SatelliteSnapshotRecord[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const definitions = getDefinitions(entity)

    if (!definitions.length || !snapshot?.length) {
      return
    }

    const knex = this.knex(sharedContext)

    const created = snapshot
      .filter((record) => !record.existed)
      .map((record) => record.id)

    if (created.length) {
      await knex(satelliteTableName(entity))
        .whereIn(ownerColumnName(entity), created)
        .delete()
    }

    for (const record of snapshot) {
      if (!record.existed) {
        continue
      }

      const values: Record<string, unknown> = {}

      for (const definition of definitions) {
        const value = record.values?.[definition.key] ?? null

        // The one piece of `coerceValue` a raw write still needs: the snapshot
        // holds jsonb values parsed into objects, and the driver mangles a
        // plain object handed to a jsonb column.
        values[definition.key] =
          definition.type === CustomFieldType.json &&
          value !== null &&
          typeof value !== "string"
            ? JSON.stringify(value)
            : value
      }

      // Carried explicitly so `upsertRow_` does not apply its default
      // resurrect-on-write: a row that was soft-deleted at snapshot time goes
      // back soft-deleted.
      values["deleted_at"] = record.deleted_at ?? null

      await this.upsertRow_(knex, entity, record.id, values)
    }
  }

  /**
   * Hard-delete owners' satellite rows. Mirrors `MedusaService`'s
   * `delete<Model>`: the rows are gone, whatever their soft-deletion state.
   *
   * Pair with {@link snapshotValues} / {@link restoreSnapshot} when the delete
   * needs to be compensable — a hard delete has no other undo.
   */
  @InjectTransactionManager()
  async deleteValues(
    entity: string,
    ownerIds: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const definitions = getDefinitions(entity)

    if (!definitions.length || !ownerIds.length) {
      return
    }

    await this.knex(sharedContext)(satelliteTableName(entity))
      .whereIn(ownerColumnName(entity), ownerIds)
      .delete()
  }

  /**
   * Soft-delete owners' satellite rows, in tandem with the owner being
   * soft-deleted. Mirrors `MedusaService`'s `softDelete<Model>`.
   *
   * @returns the ids whose rows actually transitioned, so a compensation can
   * restore exactly those — an owner whose row was already soft-deleted, or
   * who has no row, is left alone and not resurrected by the undo.
   */
  @InjectTransactionManager()
  async softDeleteValues(
    entity: string,
    ownerIds: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<string[]> {
    const definitions = getDefinitions(entity)

    if (!definitions.length || !ownerIds.length) {
      return []
    }

    const owner = ownerColumnName(entity)
    const knex = this.knex(sharedContext)

    const rows: Record<string, unknown>[] = await knex(
      satelliteTableName(entity)
    )
      .whereIn(owner, ownerIds)
      .whereNull("deleted_at")
      .update({ deleted_at: knex.fn.now() })
      .returning(owner)

    return rows.map((row) => row[owner] as string)
  }

  /**
   * Un-soft-delete owners' satellite rows — "restore" in the Medusa sense,
   * mirroring `MedusaService`'s `restore<Model>`.
   *
   * @returns the ids whose rows actually transitioned, so a compensation can
   * re-soft-delete exactly those.
   */
  @InjectTransactionManager()
  async restoreValues(
    entity: string,
    ownerIds: string[],
    @MedusaContext() sharedContext: Context = {}
  ): Promise<string[]> {
    const definitions = getDefinitions(entity)

    if (!definitions.length || !ownerIds.length) {
      return []
    }

    const owner = ownerColumnName(entity)
    const knex = this.knex(sharedContext)

    const rows: Record<string, unknown>[] = await knex(
      satelliteTableName(entity)
    )
      .whereIn(owner, ownerIds)
      .whereNotNull("deleted_at")
      .update({ deleted_at: null })
      .returning(owner)

    return rows.map((row) => row[owner] as string)
  }

  /**
   * The correctness boundary for custom field values.
   *
   * Route-level validation gives HTTP callers a good 400 and drives the admin
   * form, but it only covers HTTP. This runs on every write.
   *
   * @param partial - when true, absent keys are left alone rather than treated
   * as omissions. Update calls are partial; create calls are not.
   */
  validateValues(
    entity: string,
    values: Record<string, unknown>,
    { partial = false }: { partial?: boolean } = {}
  ): Record<string, unknown> {
    const definitions = getDefinitions(entity)

    if (!definitions.length) {
      if (Object.keys(values ?? {}).length) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `No custom fields are configured for "${entity}"`
        )
      }
      return {}
    }

    const byKey = new Map(definitions.map((d) => [d.key, d]))

    for (const key of Object.keys(values ?? {})) {
      if (!byKey.has(key)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `"${key}" is not a custom field on "${entity}"`
        )
      }
    }

    const validated: Record<string, unknown> = {}

    for (const definition of definitions) {
      const provided = isDefined(values?.[definition.key])
      const value = values?.[definition.key]

      if (!provided || value === null) {
        // A partial update leaves untouched keys alone; explicitly clearing a
        // value still has to satisfy the required constraint.
        if (partial && !provided) {
          continue
        }

        if (definition.required) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `"${definition.key}" is required on "${entity}"`
          )
        }

        validated[definition.key] = isDefined(definition.default_value)
          ? definition.default_value
          : null
        continue
      }

      validated[definition.key] = coerceValue(entity, definition, value)
    }

    return validated
  }
}

type SatelliteListConfig = {
  select?: string[]
  take?: number
  skip?: number
  order?: Record<string, string>
}

/**
 * The comparison operators translated to SQL. The joiner and the HTTP filter
 * shape both permit MikroORM-style operator objects, and knex throws an opaque
 * driver error when handed one as a `where` value — so the common ones are
 * translated, and anything else is rejected as a clear 400 naming the
 * operator.
 */
const FILTER_OPERATORS: Record<string, string> = {
  $eq: "=",
  $ne: "!=",
  $gt: ">",
  $gte: ">=",
  $lt: "<",
  $lte: "<=",
  $like: "like",
  $ilike: "ilike",
}

function applyFilter(
  entity: string,
  query: any,
  column: string,
  value: unknown
): any {
  if (Array.isArray(value)) {
    return query.whereIn(column, value)
  }

  if (value === null) {
    return query.whereNull(column)
  }

  if (!isObject(value)) {
    return query.where(column, value)
  }

  for (const [operator, operand] of Object.entries(value)) {
    if (operator === "$in" && Array.isArray(operand)) {
      query = query.whereIn(column, operand)
      continue
    }

    if (operator === "$nin" && Array.isArray(operand)) {
      query = query.whereNotIn(column, operand)
      continue
    }

    if (operator === "$eq" && operand === null) {
      query = query.whereNull(column)
      continue
    }

    if (operator === "$ne" && operand === null) {
      query = query.whereNotNull(column)
      continue
    }

    const sql = FILTER_OPERATORS[operator]

    if (!sql || isObject(operand) || Array.isArray(operand)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unsupported filter operator "${operator}" on custom field "${column}" of "${entity}"`
      )
    }

    query = query.where(column, sql, operand)
  }

  return query
}

function coerceValue(
  entity: string,
  definition: CustomFieldDefinition,
  value: unknown
): unknown {
  const invalid = (expected: string): never => {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `"${definition.key}" on "${entity}" expects ${expected}, received ${typeof value}`
    )
  }

  const toFinite = (): number => {
    const numeric = typeof value === "string" ? Number(value) : value
    return typeof numeric === "number" && Number.isFinite(numeric)
      ? numeric
      : (invalid("a number") as never)
  }

  switch (definition.type) {
    case CustomFieldType.text:
      return typeof value === "string" ? value : invalid("a string")

    case CustomFieldType.boolean:
      return typeof value === "boolean" ? value : invalid("a boolean")

    // `number` is an integer column, matching DML. Decimals belong to `float`,
    // and rounding one silently would lose data the caller sent.
    case CustomFieldType.number: {
      const numeric = toFinite()
      return Number.isInteger(numeric) ? numeric : invalid("an integer")
    }

    case CustomFieldType.float:
      return toFinite()

    case CustomFieldType.dateTime: {
      const date = value instanceof Date ? value : new Date(value as string)
      return Number.isNaN(date.getTime()) ? invalid("a date") : date
    }

    case CustomFieldType.enum:
      return definition.choices?.includes(value as string)
        ? value
        : invalid(`one of: ${definition.choices?.join(", ")}`)

    // Serialized here rather than left to the driver, which would otherwise
    // stringify an object as "[object Object]" into a jsonb column.
    case CustomFieldType.json:
      return JSON.stringify(value)

    default:
      return invalid("a supported type")
  }
}
