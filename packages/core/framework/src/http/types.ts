import type {
  ZodNullable,
  ZodObject,
  ZodOptional,
  ZodRawShape,
} from "@medusajs/deps/zod"
import type { NextFunction, Request, Response } from "express"

import {
  FindConfig,
  MedusaPricingContext,
  RequestQueryFields,
} from "@medusajs/types"
import { MedusaContainer } from "../container"
import { PolicyAction } from "./middlewares/check-permissions"
import { RestrictedFields } from "./utils/restricted-fields"

/**
 * List of all the supported HTTP methods
 */
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const

export type RouteVerb = (typeof HTTP_METHODS)[number]
export type MiddlewareVerb = "USE" | "ALL" | RouteVerb

type SyncRouteHandler = (req: MedusaRequest, res: MedusaResponse) => void

export type AsyncRouteHandler = (
  req: MedusaRequest,
  res: MedusaResponse
) => Promise<void>

export type RouteHandler = SyncRouteHandler | AsyncRouteHandler

export type MiddlewareFunction =
  | MedusaRequestHandler
  | ((...args: any[]) => any)

export type MedusaErrorHandlerFunction = (
  error: any,
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) => Promise<void> | void

export type ParserConfigArgs = {
  sizeLimit?: string | number | undefined
  preserveRawBody?: boolean
}

export type ParserConfig = false | ParserConfigArgs

export type MiddlewareRoute = {
  /**
   * @deprecated. Instead use {@link MiddlewareRoute.methods}
   */
  method?: MiddlewareVerb | MiddlewareVerb[]
  methods?: MiddlewareVerb[]
  matcher: string | RegExp
  bodyParser?: ParserConfig
  additionalDataValidator?: ZodRawShape
  middlewares?: MiddlewareFunction[]
  /**
   * The entity this route reads or writes — for example `product`, or
   * `product_variant` for a route nested under one.
   *
   * Declaring it lets the framework merge an application's configured custom
   * fields into the route's request validation, so those fields can be sent and
   * filtered on without the route knowing anything about them.
   *
   * Stated explicitly rather than inferred: the path is ambiguous for nested
   * routes, and `policies` is a security annotation whose coverage is driven by
   * RBAC's needs, so binding request shape to it would make a missing policy
   * silently drop custom field support.
   */
  entity?: string
  /** @ignore */
  policies?:
    | { resource: string; operation: string }
    | Array<{ resource: string; operation: string | string[] }>
}

export type MiddlewaresConfig = {
  errorHandler?: false | MedusaErrorHandlerFunction
  routes?: MiddlewareRoute[]
}

/**
 * Route descriptor refers represents a route either scanned
 * from the filesystem or registered manually. It does not
 * represent a middleware
 */
export type RouteDescriptor = {
  matcher: string
  method: RouteVerb
  handler: RouteHandler
  optedOutOfAuth: boolean
  isRoute: true
  routeType?: "admin" | "store" | "auth"
  absolutePath?: string
  relativePath?: string
  shouldAppendAdminCors: boolean
  shouldAppendStoreCors: boolean
  shouldAppendAuthCors: boolean
}

/**
 * Represents a middleware
 */
export type MiddlewareDescriptor = {
  matcher: string | RegExp
  methods?: MiddlewareVerb | MiddlewareVerb[]
  handler: MiddlewareFunction
  /**
   * See {@link MiddlewareRoute.entity}.
   */
  entity?: string
  policies?:
    | { resource: string; operation: string }
    | Array<{ resource: string; operation: string | string[] }>
}

export type BodyParserConfigRoute = {
  matcher: string | RegExp
  methods: MiddlewareVerb | MiddlewareVerb[]
  config: ParserConfig
}

export type AdditionalDataValidatorRoute = {
  matcher: string | RegExp
  methods: MiddlewareVerb | MiddlewareVerb[]
  schema: ZodRawShape
  validator: ZodOptional<ZodNullable<ZodObject<any, any>>>
}

export type GlobalMiddlewareDescriptor = {
  config?: MiddlewaresConfig
}

export interface MedusaRequest<
  Body = unknown,
  QueryFields = Record<string, unknown>
> extends Request<{ [key: string]: string }, any, Body> {
  validatedBody: Body
  validatedQuery: RequestQueryFields & QueryFields
  /**
   * TODO: shouldn't this correspond to returnable fields instead of allowed fields? also it is used by the cleanResponseData util
   */
  allowedProperties: string[]
  /**
   * An object containing the select, relation, skip, take and order to be used with medusa internal services
   */
  listConfig: FindConfig<unknown>
  /**
   * An object containing the select, relation to be used with medusa internal services
   */
  retrieveConfig: FindConfig<unknown>

  /**
   * An object containing fields and variables to be used with the remoteQuery
   *
   * @since 2.2.0
   */
  queryConfig: {
    fields: string[]
    pagination: { order?: Record<string, string>; skip: number; take?: number }
    withDeleted?: boolean
  }

  /**
   * @deprecated Use {@link queryConfig} instead.
   */
  remoteQueryConfig: MedusaRequest["queryConfig"]

  /**
   * An object containing the fields that are filterable e.g `{ id: Any<String> }`
   */
  filterableFields: QueryFields
  includes?: Record<string, boolean>

  /**
   * An array of fields and relations that are allowed to be queried, this can be set by the
   * consumer as part of a middleware and it will take precedence over the req.allowed set
   * by the api
   */
  allowed?: string[]
  errors: string[]
  scope: MedusaContainer
  session?: any
  rawBody?: any
  requestId?: string

  restrictedFields?: RestrictedFields

  /**
   * An object that carries the context that is used to calculate prices for variants
   */
  pricingContext?: MedusaPricingContext
  /**
   * A generic context object that can be used across the request lifecycle
   */
  context?: Record<string, any>

  /**
   * Custom validator to validate the `additional_data` property in
   * requests that allows for additional_data
   */
  additionalDataValidator?: ZodOptional<ZodNullable<ZodObject<any, any>>>

  /**
   * The entity this route declared, resolved once by the router. Read by
   * `persistCustomFields` so it works from the same value the validation shapes
   * were built from.
   */
  customFieldsEntity?: string

  /**
   * Names the route parameter holding the id of the record this route operates
   * on — `"id"` for `/admin/brands/:id`, `"variant_id"` for
   * `/admin/products/:id/variants/:variant_id` — resolved by the router from
   * the matcher's final segment. Unset when the matcher ends in a literal
   * segment: such a route creates records (or is an action route), and ids are
   * read from the response instead.
   */
  customFieldsOwnerParam?: string

  /**
   * Names the *last* route parameter appearing anywhere in the matcher —
   * `"id"` for `/admin/brands/:id/restore`, where the matcher ends in a
   * literal and {@link customFieldsOwnerParam} is therefore unset. Used by the
   * delete and restore middlewares, which never create records and so can
   * safely target the last id in an action-style path. `persistCustomFields`
   * must not use this: its create-vs-update decision needs the stricter
   * final-segment rule.
   */
  customFieldsLastParam?: string

  /**
   * Zod shape for the custom fields configured on the entity this route
   * operates on, resolved from the route's declared `entity`. Merged into the
   * body schema by `validateAndTransformBody`, so custom fields arrive as
   * top-level keys rather than nested under an optional object.
   */
  customFieldsValidator?: ZodRawShape

  /**
   * Zod shape for filtering on the same entity's custom fields. Merged into the
   * query schema by `validateAndTransformQuery` under a `custom_fields` key,
   * matching the shape reads come back in and the shape `query.graph` filters
   * on.
   */
  customFieldsFilterValidator?: ZodRawShape

  /**
   * The locale for the current request, resolved from:
   * 1. Query parameter `?locale=`
   * 2. x-medusa-locale header
   * 3. Store's default locale
   */
  locale?: string
}

export interface AuthContext {
  actor_id: string
  actor_type: string
  auth_identity_id: string
  auth_provider?: string
  app_metadata: Record<string, unknown>
  user_metadata: Record<string, unknown>
  entity_id?: string
  purpose?: string
  jti?: string
  /**
   * Whether the auth identity had an enabled MFA factor when the token was issued.
   */
  mfa_enabled?: boolean
  /**
   * When the MFA challenge was completed, or null when it has not been. Routes
   * can require a recent completion to gate elevated actions.
   */
  mfa_challenge_completed_at?: string | null
}

export interface PublishableKeyContext {
  key: string
  sales_channel_ids: string[]
}

export interface SecretKeyContext {
    created_by: string
}

export interface AuthenticatedMedusaRequest<
  Body = unknown,
  QueryFields = Record<string, unknown>
> extends MedusaRequest<Body, QueryFields> {
  auth_context: AuthContext
  publishable_key_context?: PublishableKeyContext
  secret_key_context?: SecretKeyContext
  policies?: PolicyAction[]
}

export interface MedusaStoreRequest<
  Body = unknown,
  QueryFields = Record<string, unknown>
> extends MedusaRequest<Body, QueryFields> {
  auth_context?: AuthContext
  publishable_key_context: PublishableKeyContext
  policies?: PolicyAction | PolicyAction[]
}

export type MedusaResponse<Body = unknown> = Response<Body>

export type MedusaNextFunction = NextFunction

export type MedusaRequestHandler<Body = unknown, Res = unknown> = (
  req: MedusaRequest<Body>,
  res: MedusaResponse<Res>,
  next: MedusaNextFunction
) => Promise<void> | void

/**
 * A route's declared entity, in the shape the routes finder needs. Used to
 * resolve which entity a request operates on when merging custom fields into
 * request validation.
 */
export type EntityRoute = {
  matcher: string | RegExp
  methods: MiddlewareVerb | MiddlewareVerb[]
  entity: string
}
