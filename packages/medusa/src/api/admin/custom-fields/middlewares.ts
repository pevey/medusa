import { validateAndTransformQuery } from "@medusajs/framework"
import { MiddlewareRoute } from "@medusajs/framework/http"
import { ensureCustomFieldsEnabled } from "./middleware"
import { AdminGetCustomFieldsParams } from "./validators"

export const customFieldsRoutesMiddlewares: MiddlewareRoute[] = [
  {
    method: ["GET"],
    matcher: "/admin/custom-fields",
    middlewares: [
      ensureCustomFieldsEnabled,
      validateAndTransformQuery(AdminGetCustomFieldsParams, {}),
    ],
  },
]
