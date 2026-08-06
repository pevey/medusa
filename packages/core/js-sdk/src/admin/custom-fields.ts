import { HttpTypes } from "@medusajs/types"

import { Client } from "../client.js"
import { ClientHeaders } from "../types.js"

/**
 * This class is used to send requests to the custom fields admin API routes.
 * It can be accessed via `sdk.admin.customFields`.
 *
 * Custom fields are user-defined typed fields configured on the custom fields
 * module. The admin dashboard uses the definitions to render inputs and
 * displays at runtime.
 */
export class CustomFields {
  constructor(private client: Client) {}

  /**
   * This method retrieves the configured custom field definitions.
   *
   * @param {HttpTypes.AdminCustomFieldDefinitionListParams} query - Filter the definitions by entity.
   * @param {ClientHeaders} headers - Headers to pass in the request.
   * @returns {Promise<HttpTypes.AdminCustomFieldDefinitionListResponse>} The custom field definitions.
   *
   * @example
   * sdk.admin.customFields.list({ entity: "product" })
   * .then(({ definitions }) => {
   *   console.log(definitions)
   * })
   *
   * @tags customFields
   * @since 2.11.0
   * @featureFlag custom_fields
   */
  async list(
    query?: HttpTypes.AdminCustomFieldDefinitionListParams,
    headers?: ClientHeaders
  ): Promise<HttpTypes.AdminCustomFieldDefinitionListResponse> {
    return await this.client.fetch("/admin/custom-fields", {
      method: "GET",
      headers,
      query,
    })
  }
}
