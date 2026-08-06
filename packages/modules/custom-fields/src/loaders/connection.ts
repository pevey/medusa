import { InternalModuleDeclaration, LoaderOptions } from "@medusajs/types"
import { join } from "path"
import {
  FeatureFlag,
  MedusaError,
  Modules,
  ModulesSdkUtils,
  toMikroOrmEntities,
} from "@medusajs/framework/utils"
import { CustomFieldsModuleService } from "@/services"
import { CustomFieldsModuleOptions } from "@/types"
import {
  buildSatellites,
  publishCustomFieldSchemas,
  registerCustomFieldLinks,
  resolveDefinitions,
} from "@/utils"

/**
 * Replaces the connection loader the module system would otherwise generate.
 *
 * `prepareLoaders` skips its own connection loader when the module exports one
 * by this name, which is the supported way to hand MikroORM an entity list that
 * is not simply everything under `src/models`. Satellite entities are derived
 * from configuration, so there is nothing on disk for the usual discovery to
 * find.
 */
export default async function connectionLoader(
  { options, container, logger }: LoaderOptions<CustomFieldsModuleOptions>,
  moduleDeclaration?: InternalModuleDeclaration
): Promise<void> {
  // Custom-field filtering rests on cross-module join pushdown — the machinery
  // that replaces the index engine (deprecated by PR #16156). The index engine
  // knows nothing of satellite tables: a custom-field filter routed through it
  // would be silently dropped and return every record. One boot-time refusal
  // beats carving custom fields out of every index-engine consumer route.
  if (FeatureFlag.isFeatureEnabled("index_engine")) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `The custom fields module cannot run alongside the "index_engine" feature flag. ` +
        `The index engine does not see custom field satellite tables, so filters on them ` +
        `would silently return every record. Disable one of the two — the index engine is ` +
        `deprecated in favor of cross-module joins, which custom fields use natively.`
    )
  }

  const definitionsByEntity = resolveDefinitions(options)
  const satellites = buildSatellites(definitionsByEntity)

  if (satellites.length) {
    const entities = [...definitionsByEntity.keys()]

    logger?.debug?.(
      `Custom fields: ${satellites.length} satellite ${
        satellites.length === 1 ? "entity" : "entities"
      } for ${entities.join(", ")}`
    )

    // Registered here rather than from a `links/` file because the linked
    // entities are only known once configuration has been resolved. The
    // callbacks are consumed after every module has loaded, so resolving the
    // owning module inside them is safe.
    registerCustomFieldLinks(entities, logger)
    CustomFieldsModuleService.registerSatelliteMethods(entities)
  }

  // Published even when empty so a previous boot's shapes cannot linger.
  publishCustomFieldSchemas(definitionsByEntity)

  await ModulesSdkUtils.mikroOrmConnectionLoaderFactory({
    moduleName: Modules.CUSTOM_FIELDS,
    // DML entities have to be converted before MikroORM sees them. The
    // generated connection loader does this in `prepareLoaders`; replacing it
    // means doing it here.
    moduleModels: toMikroOrmEntities(satellites),
    // The directory is empty by design (see its index), but MikroORM needs a
    // path that resolves.
    migrationsPath: join(__dirname, "..", "migrations"),
  })({ options, container, logger }, moduleDeclaration)
}
