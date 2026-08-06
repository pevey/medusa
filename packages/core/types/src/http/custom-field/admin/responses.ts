import { AdminCustomFieldDefinition } from "./entities"

export interface AdminCustomFieldDefinitionListResponse {
  /**
   * The configured custom field definitions, grouped by entity in stable
   * key order.
   */
  definitions: AdminCustomFieldDefinition[]
}
