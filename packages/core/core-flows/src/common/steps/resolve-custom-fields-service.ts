import { Modules } from "@medusajs/framework/utils"

/**
 * The custom fields module service, or undefined when the module is not
 * installed — or installed but disabled, which is the case `hasRegistration`
 * cannot see: a disabled module's container key is still registered, holding
 * `undefined`. Every custom-fields step guards through this so it no-ops in
 * both cases.
 */
export function resolveCustomFieldsService(container: {
  resolve: (key: string, opts?: { allowUnregistered?: boolean }) => any
}): any | undefined {
  return container.resolve(Modules.CUSTOM_FIELDS, { allowUnregistered: true })
}
