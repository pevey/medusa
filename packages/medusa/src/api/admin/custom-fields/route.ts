import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { HttpTypes } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { AdminGetCustomFieldsParamsType } from "./validators"

type CustomFieldsService = {
  listConfiguredEntities(): string[]
  listDefinitions(entity: string): (HttpTypes.AdminCustomFieldDefinition & {
    indexed: boolean
  })[]
}

/**
 * List the configured custom field definitions, so the admin dashboard can
 * render inputs and displays from runtime metadata.
 *
 * @since 2.11.0
 * @featureFlag custom_fields
 */
export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse<HttpTypes.AdminCustomFieldDefinitionListResponse>
) => {
  /**
   * A disabled module's container key is still registered, holding
   * `undefined` — so the resolved value needs checking, not just the
   * registration. Flag on but module absent simply means nothing is
   * configured.
   */
  const service = req.scope.resolve(Modules.CUSTOM_FIELDS, {
    allowUnregistered: true,
  }) as CustomFieldsService | undefined

  if (!service) {
    return res.json({ definitions: [] })
  }

  const { entity } = req.validatedQuery as AdminGetCustomFieldsParamsType

  const entities = entity ? [entity] : service.listConfiguredEntities()

  const definitions = entities.flatMap((entityName) =>
    service.listDefinitions(entityName).map(
      ({ indexed: _indexed, ...definition }) => definition
    )
  )

  return res.json({ definitions })
}
