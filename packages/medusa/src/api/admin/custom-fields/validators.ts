import { z } from "@medusajs/framework/zod"

export type AdminGetCustomFieldsParamsType = z.infer<
  typeof AdminGetCustomFieldsParams
>
export const AdminGetCustomFieldsParams = z.object({
  entity: z.string().optional(),
})
