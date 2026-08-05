import { CustomFieldsModuleService } from "@/services"
import { Module } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/utils"
import connectionLoader from "./loaders/connection"

export default Module(Modules.CUSTOM_FIELDS, {
  service: CustomFieldsModuleService,
  loaders: [connectionLoader],
})

export * from "./types"
export * from "./utils"
