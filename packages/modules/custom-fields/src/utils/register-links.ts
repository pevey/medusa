import { Logger, ModuleJoinerConfig } from "@medusajs/framework/types"
import { MedusaModule } from "@medusajs/framework/modules-sdk"
import { Modules } from "@medusajs/framework/utils"
import { getDefinitions } from "./satellite-registry"
import { ownerColumnName, satelliteEntityName } from "./satellite"

export const CUSTOM_FIELDS_ALIAS = "custom_fields"

/**
 * Every alias any module exposes to `query.graph`, singular and plural.
 */
function collectAliases(modules: ModuleJoinerConfig[]): Set<string> {
  const aliases = new Set<string>()

  for (const config of modules) {
    const declared = Array.isArray(config.alias)
      ? config.alias
      : config.alias
      ? [config.alias]
      : []

    for (const alias of declared) {
      for (const name of Array.isArray(alias.name) ? alias.name : [alias.name]) {
        aliases.add(name)
      }
    }
  }

  return aliases
}

/**
 * Warn when a custom field key is also the name of something in the entity
 * graph.
 *
 * A filter on such a key is read as a hop to that entity rather than as a
 * column on the satellite. Cross-module join pushdown then becomes ineligible
 * and the filter is **discarded rather than rejected** — so a merchant
 * filtering by the field is shown every record, with nothing to indicate the
 * filter did not apply.
 *
 * A warning rather than a boot failure: the field still stores and reads
 * correctly, only filtering is affected, and failing an existing installation's
 * boot because an unrelated plugin later introduced a colliding alias would be
 * a worse outcome than a loud log line.
 */
function warnOnAliasCollisions(
  modules: ModuleJoinerConfig[],
  entity: string,
  logger?: Logger
): void {
  if (!logger) {
    return
  }

  const aliases = collectAliases(modules)

  for (const definition of getDefinitions(entity)) {
    if (!aliases.has(definition.key)) {
      continue
    }

    logger.warn(
      `Custom field "${entity}.${definition.key}" has the same name as an entity in the query graph. ` +
        `Filtering on "${CUSTOM_FIELDS_ALIAS}.${definition.key}" will be ignored and return every record. ` +
        `Rename the field to something the graph does not already use.`
    )
  }
}

/**
 * Find the module that owns an entity, and that entity's PascalCase name, by
 * looking for the alias in the joiner configs.
 *
 * Resolution has to happen inside the register callback rather than up front:
 * modules are bootstrapped in parallel, so at the time this module's loaders
 * run there is no guarantee the owning module has been loaded yet. The callback
 * is invoked later with every joiner config already collected.
 */
function findOwner(
  modules: ModuleJoinerConfig[],
  entity: string
): { serviceName: string; entity: string } | undefined {
  for (const config of modules) {
    if (config.isLink) {
      continue
    }

    const aliases = Array.isArray(config.alias)
      ? config.alias
      : config.alias
      ? [config.alias]
      : []

    for (const alias of aliases) {
      const names = Array.isArray(alias.name) ? alias.name : [alias.name]
      if (names.includes(entity) && alias.entity) {
        return { serviceName: config.serviceName!, entity: alias.entity }
      }
    }
  }

  return undefined
}

/**
 * Make `<entity>.custom_fields` traversable through `query.graph`.
 *
 * This is a read-only link, so it contributes `extends` config and no link
 * table: the satellite's primary key is the owning entity's id, letting the
 * joiner go straight from `product.id` to `product_custom_field.product_id`.
 */
export function registerCustomFieldLinks(
  entities: string[],
  logger?: Logger
): void {
  for (const entity of entities) {
    const register = function (
      modules: ModuleJoinerConfig[]
    ): ModuleJoinerConfig {
      // Deferred to here for the same reason the owner lookup is: this is the
      // first point at which every module's aliases are known.
      warnOnAliasCollisions(modules, entity, logger)

      const owner = findOwner(modules, entity)

      if (!owner) {
        // The owning module is not installed. Contribute nothing rather than
        // failing the boot — the satellite table is harmless on its own.
        return { isLink: true, isReadOnlyLink: true, extends: [] }
      }

      return {
        isLink: true,
        isReadOnlyLink: true,
        extends: [
          {
            serviceName: owner.serviceName,
            entity: owner.entity,
            relationship: {
              serviceName: Modules.CUSTOM_FIELDS,
              entity: satelliteEntityName(entity),
              primaryKey: ownerColumnName(entity),
              foreignKey: "id",
              alias: CUSTOM_FIELDS_ALIAS,
              isList: false,
            },
          },
        ],
      }
    }

    MedusaModule.setCustomLink(register)
  }
}
