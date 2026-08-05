import { FlagSettings } from "@medusajs/framework/feature-flags"

const CustomFieldsFeatureFlag: FlagSettings = {
  key: "custom_fields",
  default_val: false,
  env_key: "MEDUSA_FF_CUSTOM_FIELDS",
  description: "Enable user-defined custom fields on core entities",
}

export default CustomFieldsFeatureFlag
