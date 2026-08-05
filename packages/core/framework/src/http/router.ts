import {
  ContainerRegistrationKeys,
  FeatureFlag,
  getCustomFieldSchema,
  hasCustomFieldSchemas,
  isFileDisabled,
  parseCorsOrigins,
} from "@medusajs/utils"
import cors, { CorsOptions } from "cors"
import type {
  ErrorRequestHandler,
  Express,
  IRouter,
  RequestHandler,
} from "express"
import type {
  AdditionalDataValidatorRoute,
  BodyParserConfigRoute,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
  MiddlewareDescriptor,
  EntityRoute,
  MiddlewareFunction,
  MiddlewareVerb,
  RouteDescriptor,
  RouteHandler,
} from "./types"
import { HTTP_METHODS } from "./types"

import { Logger, MedusaContainer } from "@medusajs/types"
import { join } from "path"
import { configManager } from "../config"
import { MiddlewareFileLoader } from "./middleware-file-loader"
import { applyLocale, authenticate, AuthType } from "./middlewares"
import { createBodyParserMiddlewaresStack } from "./middlewares/bodyparser"
import { wrapWithPoliciesCheck } from "./middlewares/check-permissions"
import { ensurePublishableApiKeyMiddleware } from "./middlewares/ensure-publishable-api-key"
import { errorHandler } from "./middlewares/error-handler"
import { RoutesFinder } from "./routes-finder"
import { RoutesLoader } from "./routes-loader"
import { RoutesSorter } from "./routes-sorter"
import { RestrictedFields } from "./utils/restricted-fields"
import { wrapHandler } from "./utils/wrap-handler"

export class ApiLoader {
  /**
   * Wrap the original route handler implementation for
   * instrumentation.
   */
  static traceRoute?: (
    handler: RouteHandler,
    route: { route: string; method: string }
  ) => RouteHandler

  /**
   * Wrap the original middleware handler implementation for
   * instrumentation.
   */
  static traceMiddleware?: (
    handler: RequestHandler | MiddlewareFunction,
    route: { route: string; method?: string }
  ) => RequestHandler | MiddlewareFunction

  /**
   * An express instance
   * @private
   */
  readonly #app: Express

  /**
   * Path from where to load the routes from
   * @private
   */
  readonly #sourceDirs: string[]

  readonly #logger: Logger

  constructor({
    app,
    sourceDir,
    baseRestrictedFields = [],
    container,
  }: {
    app: Express
    sourceDir: string | string[]
    baseRestrictedFields?: string[]
    container: MedusaContainer
  }) {
    this.#app = app
    this.#sourceDirs = Array.isArray(sourceDir) ? sourceDir : [sourceDir]
    this.#assignRestrictedFields(baseRestrictedFields ?? [])
    this.#logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  }

  /**
   * Loads routes, middleware, bodyParserConfig routes, routes that have
   * opted out for Auth and CORS and the error handler.
   */
  async #loadHttpResources() {
    const routesLoader = new RoutesLoader()

    const middlewareLoader = new MiddlewareFileLoader()

    for (const dir of this.#sourceDirs) {
      await routesLoader.scanDir(dir)
      await middlewareLoader.scanDir(dir)
    }

    return {
      routes: routesLoader.getRoutes(),
      routesFinder: new RoutesFinder<RouteDescriptor>(),
      middlewares: middlewareLoader.getMiddlewares(),
      errorHandler: middlewareLoader.getErrorHandler() as
        | ErrorRequestHandler
        | undefined,
      bodyParserConfigRoutes: middlewareLoader.getBodyParserConfigRoutes(),
      additionalDataValidatorRoutes:
        middlewareLoader.getAdditionalDataValidatorRoutes(),
    }
  }

  /**
   * Checks if a route file is disabled for a given matcher and method
   * by trying to find the corresponding route file path
   */
  #isRouteFileDisabled(matcher: string | RegExp): boolean {
    /**
     * A regular expression matcher does not map to a single route file on the
     * filesystem, so there is nothing to check for being disabled.
     */
    if (matcher instanceof RegExp) {
      return false
    }

    const routePathSegments = matcher
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        if (segment.startsWith(":")) {
          return `[${segment.slice(1)}]`
        }
        return segment
      })

    for (const sourceDir of this.#sourceDirs) {
      for (const ext of [".ts", ".js"]) {
        const routeFilePath = join(
          sourceDir,
          ...routePathSegments,
          `route${ext}`
        )

        if (isFileDisabled(routeFilePath)) {
          return true
        }
      }
    }

    return false
  }

  /**
   * Registers a middleware or a route handler with Express
   */
  #registerExpressHandler(
    route: MiddlewareDescriptor | RouteDescriptor | RouteDescriptor
  ) {
    if ("isRoute" in route) {
      this.#logger.debug(`registering route ${route.method} ${route.matcher}`)
      const handler = ApiLoader.traceRoute
        ? ApiLoader.traceRoute(route.handler, {
            route: route.matcher,
            method: route.method,
          })
        : route.handler

      this.#app[route.method.toLowerCase()](route.matcher, wrapHandler(handler))

      return
    }

    const isRbacEnabled = FeatureFlag.isFeatureEnabled("rbac")
    if (!route.methods) {
      this.#logger.debug(`registering global middleware for ${route.matcher}`)

      // Wrap with permission check if policies are defined
      let handlerToUse = route.handler
      if (route.policies && isRbacEnabled) {
        handlerToUse = wrapWithPoliciesCheck(route.handler, route.policies)
      }

      const handler = ApiLoader.traceMiddleware
        ? (ApiLoader.traceMiddleware(handlerToUse, {
            route: String(route.matcher),
          }) as RequestHandler)
        : (handlerToUse as RequestHandler)

      this.#app.use(route.matcher, wrapHandler(handler))
      return
    }

    const methods = Array.isArray(route.methods)
      ? route.methods
      : [route.methods]
    methods.forEach((method) => {
      const isDisabled = this.#isRouteFileDisabled(route.matcher)
      if (isDisabled) {
        this.#logger.debug(
          `skipping disabled route middleware registration for ${method} ${route.matcher}`
        )
        return
      }

      this.#logger.debug(
        `registering route middleware ${method} ${route.matcher}`
      )

      let handlerToUse = route.handler
      if (route.policies && isRbacEnabled) {
        handlerToUse = wrapWithPoliciesCheck(route.handler, route.policies)
      }

      const handler = ApiLoader.traceMiddleware
        ? (ApiLoader.traceMiddleware(wrapHandler(handlerToUse), {
            route: String(route.matcher),
            method: method,
          }) as RequestHandler)
        : wrapHandler(handlerToUse)

      this.#app[method.toLowerCase()](route.matcher, handler)
    })
  }

  /**
   * Registers the middleware for restricted fields
   */
  #assignRestrictedFields(baseRestrictedFields: string[]) {
    this.#app.use("/store", ((
      req: MedusaRequest,
      _: MedusaResponse,
      next: MedusaNextFunction
    ) => {
      req.restrictedFields = new RestrictedFields()
      req.restrictedFields.add(baseRestrictedFields)
      next()
    }) as unknown as RequestHandler)

    this.#app.use("/admin", ((
      req: MedusaRequest,
      _: MedusaResponse,
      next: MedusaNextFunction
    ) => {
      req.restrictedFields = new RestrictedFields()
      next()
    }) as unknown as RequestHandler)
  }

  /**
   * Creates the options for the Cors middleware
   */
  #createCorsOptions(origin: string): CorsOptions {
    return {
      origin: parseCorsOrigins(origin),
      credentials: true,
      preflightContinue: false,
    }
  }

  /**
   * Assigns global cors middleware for a given prefix
   */
  #applyCorsMiddleware(
    routesFinder: RoutesFinder<RouteDescriptor>,
    namespace: string,
    toggleKey:
      | "shouldAppendAdminCors"
      | "shouldAppendAuthCors"
      | "shouldAppendStoreCors",
    corsOptions: CorsOptions
  ) {
    const logger = this.#logger
    const corsFn = cors(corsOptions)
    const corsMiddleware: RequestHandler = function corsMiddleware(
      req,
      res,
      next
    ) {
      let method: string = req.method
      if (req.method === "OPTIONS") {
        method = req.headers["access-control-request-method"] ?? req.method
      }

      const path = `${namespace}${req.path}`
      const matchingRoute = routesFinder.find(path, method as MiddlewareVerb)
      if (matchingRoute && matchingRoute[toggleKey] === true) {
        return corsFn(req, res, next)
      }

      logger.debug(`Skipping CORS middleware ${req.method} ${path}`)
      return next()
    }

    this.#app.use(
      namespace,
      ApiLoader.traceMiddleware
        ? (ApiLoader.traceMiddleware(corsMiddleware, {
            route: namespace,
          }) as RequestHandler)
        : corsMiddleware
    )
  }

  /**
   * Applies the route middleware on a route. Encapsulates the logic
   * needed to pass the middleware via the trace calls
   */
  #applyAuthMiddleware(
    routesFinder: RoutesFinder<RouteDescriptor>,
    namespace: string,
    actorType: string | string[],
    authType: AuthType | AuthType[],
    options?: { allowUnauthenticated?: boolean; allowUnregistered?: boolean }
  ) {
    const logger = this.#logger
    logger.debug(`Registering auth middleware for prefix ${namespace}`)

    const originalFn = authenticate(actorType, authType, options)
    const authMiddleware: RequestHandler = function authMiddleware(
      req,
      res,
      next
    ) {
      const path = `${namespace}${req.path}`
      const matchingRoute = routesFinder.find(
        path,
        req.method as MiddlewareVerb
      )
      if (matchingRoute && matchingRoute.optedOutOfAuth) {
        logger.debug(`Skipping auth ${req.method} ${path}`)
        return next()
      }

      logger.debug(`Authenticating route ${req.method} ${path}`)
      return originalFn(req, res, next)
    }

    this.#app.use(
      namespace,
      ApiLoader.traceMiddleware
        ? (ApiLoader.traceMiddleware(authMiddleware, {
            route: namespace,
          }) as RequestHandler)
        : authMiddleware
    )
  }

  /**
   * Apply the most specific body parser middleware to the router
   */
  #applyBodyParserMiddleware(
    namespace: string,
    routesFinder: RoutesFinder<BodyParserConfigRoute>
  ): void {
    this.#logger.debug(
      `Registering bodyparser middleware for prefix ${namespace}`
    )
    this.#app.use(
      namespace,
      createBodyParserMiddlewaresStack(
        namespace,
        routesFinder,
        ApiLoader.traceMiddleware
      )
    )
  }

  /**
   * Applies the route middleware on a route. Encapsulates the logic
   * needed to pass the middleware via the trace calls
   */
  /**
   * Hand a route the custom field shapes for the entity it declares, so an
   * application's configured fields can be sent in the body and filtered on in
   * the query.
   *
   * Keyed on the route's own `entity` annotation. Not on `policies`: those are a
   * security annotation whose coverage exists because RBAC needs it, so binding
   * request shape to them would make a route without a policy silently lose
   * custom field support — with the symptom (`Unrecognized fields`) nowhere near
   * the cause. And not on the path, which is ambiguous for nested routes.
   *
   * Writes always get the permissive shape, where every field is optional.
   * `required` is not enforced here — it is enforced ahead of the write by
   * `validateCustomFieldsStep`, which covers every caller rather than only the
   * ones arriving over HTTP.
   */
  #assignCustomFieldsValidator(
    namespace: string,
    routesFinder: RoutesFinder<EntityRoute>
  ) {
    const logger = this.#logger
    logger.debug(
      `Registering assignCustomFieldsValidator middleware for prefix ${namespace}`
    )

    const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"])

    /**
     * The owner param, when the matcher's final segment is one. A route whose
     * matcher ends in a param operates on that existing record —
     * `/admin/brands/:id`, `/admin/products/:id/variants/:variant_id` — and
     * the param names which of `req.params` holds the owner's id. A matcher
     * ending in a literal (a create, an action route), or one that is not a
     * string, yields nothing and `persistCustomFields` uses create semantics.
     * Read from the declared matcher rather than guessed from `req.params`,
     * where a nested create's parent id is indistinguishable from an owner.
     */
    const ownerParamFromMatcher = (
      matcher: string | RegExp
    ): string | undefined => {
      if (typeof matcher !== "string") {
        return undefined
      }

      const last = matcher.replace(/\/+$/, "").split("/").pop()

      return last?.startsWith(":") ? last.slice(1) : undefined
    }

    /**
     * The last param anywhere in the matcher — `"id"` for
     * `/admin/brands/:id/restore`. The delete and restore middlewares target
     * this: they never create records, so an action-style matcher ending in a
     * literal still has an unambiguous subject.
     */
    const lastParamFromMatcher = (
      matcher: string | RegExp
    ): string | undefined => {
      if (typeof matcher !== "string") {
        return undefined
      }

      const params = matcher
        .split("/")
        .filter((segment) => segment.startsWith(":"))

      return params.length
        ? params[params.length - 1].slice(1)
        : undefined
    }

    const customFieldsValidator = function customFieldsValidator(
      req: MedusaRequest,
      _: MedusaResponse,
      next: MedusaNextFunction
    ) {
      const route = routesFinder.find(req.path, req.method as MiddlewareVerb)
      const entity = route?.entity

      if (!route || !entity) {
        return next()
      }

      // Kept on the request so anything downstream works from the same
      // resolved value rather than restating the entity and risking drift —
      // `persistCustomFields` in particular.
      req.customFieldsEntity = entity
      req.customFieldsOwnerParam = ownerParamFromMatcher(route.matcher)
      req.customFieldsLastParam = lastParamFromMatcher(route.matcher)

      // Filtering is available on any method that reaches a query validator.
      req.customFieldsFilterValidator = getCustomFieldSchema(entity, "filter")

      if (WRITE_METHODS.has(req.method)) {
        req.customFieldsValidator = getCustomFieldSchema(entity, "update")
      }

      return next()
    }

    this.#app.use(
      namespace,
      ApiLoader.traceMiddleware
        ? (ApiLoader.traceMiddleware(customFieldsValidator, {
            route: namespace,
          }) as RequestHandler)
        : (customFieldsValidator as RequestHandler)
    )
  }

  #assignAdditionalDataValidator(
    namespace: string,
    routesFinder: RoutesFinder<AdditionalDataValidatorRoute>
  ) {
    const logger = this.#logger
    logger.debug(
      `Registering assignAdditionalDataValidator middleware for prefix ${namespace}`
    )

    const additionalDataValidator = function additionalDataValidator(
      req: MedusaRequest,
      _: MedusaResponse,
      next: MedusaNextFunction
    ) {
      const matchingRoute = routesFinder.find(
        req.path,
        req.method as MiddlewareVerb
      )
      if (matchingRoute && matchingRoute.validator) {
        logger.debug(
          `Using validator to validate additional data on ${req.method} ${req.path}`
        )
        req.additionalDataValidator = matchingRoute.validator
      }
      return next()
    }

    this.#app.use(
      namespace,
      ApiLoader.traceMiddleware
        ? (ApiLoader.traceMiddleware(additionalDataValidator, {
            route: namespace,
          }) as RequestHandler)
        : (additionalDataValidator as RequestHandler)
    )
  }

  /**
   * Applies the middleware to authenticate the headers to contain
   * a `x-publishable-key` header
   */
  #applyStorePublishableKeyMiddleware(namespace: string) {
    this.#logger.debug(
      `Registering publishable key middleware for namespace ${namespace}`
    )
    let middleware = ApiLoader.traceMiddleware
      ? ApiLoader.traceMiddleware(ensurePublishableApiKeyMiddleware, {
          route: namespace,
        })
      : ensurePublishableApiKeyMiddleware

    this.#app.use(namespace, middleware as RequestHandler)
  }

  #applyLocaleMiddleware(namespace: string) {
    this.#logger.debug(
      `Registering locale middleware for namespace ${namespace}`
    )
    let middleware = ApiLoader.traceMiddleware
      ? ApiLoader.traceMiddleware(applyLocale, {
          route: namespace,
        })
      : applyLocale
    this.#app.use(namespace, middleware as RequestHandler)
  }

  async load() {
    if (FeatureFlag.isFeatureEnabled("backend_hmr")) {
      ;(global as any).__MEDUSA_HMR_API_LOADER__ = this
    }

    const {
      errorHandler: sourceErrorHandler,
      middlewares,
      routes,
      routesFinder,
      bodyParserConfigRoutes,
      additionalDataValidatorRoutes,
    } = await this.#loadHttpResources()

    /**
     * Parse request body on all the requests and use the routes finder
     * to pick the best matching config for the given route.
     */
    const bodyParserRoutesFinder = new RoutesFinder<BodyParserConfigRoute>(
      new RoutesSorter(bodyParserConfigRoutes).sort([
        "static",
        "params",
        "regex",
        "wildcard",
        "global",
      ])
    )
    this.#applyBodyParserMiddleware("/", bodyParserRoutesFinder)

    /**
     * Use the routes finder to pick the additional data validator
     * to be applied on the current request
     */
    if (additionalDataValidatorRoutes.length) {
      const additionalDataValidatorRoutesFinder =
        new RoutesFinder<AdditionalDataValidatorRoute>(
          new RoutesSorter(additionalDataValidatorRoutes).sort([
            "static",
            "params",
            "regex",
            "wildcard",
            "global",
          ])
        )
      this.#assignAdditionalDataValidator(
        "/",
        additionalDataValidatorRoutesFinder
      )
    }

    /**
     * Custom fields are declared per entity, so a route has to state which
     * entity it operates on for them to be merged into its validation.
     */
    if (hasCustomFieldSchemas()) {
      const entityRoutes = middlewares
        .filter((descriptor) => descriptor.entity)
        .map((descriptor) => {
          // `RoutesFinder` compares the request verb against this list
          // literally, so a descriptor with no methods, or with "ALL", has to be
          // expanded rather than passed through.
          let methods = descriptor.methods ?? [...HTTP_METHODS]
          if (methods.includes("ALL")) {
            methods = [...HTTP_METHODS]
          }

          return {
            matcher: descriptor.matcher,
            methods,
            entity: descriptor.entity,
          }
        }) as unknown as EntityRoute[]

      if (entityRoutes.length) {
        this.#assignCustomFieldsValidator(
          "/",
          new RoutesFinder<EntityRoute>(
            new RoutesSorter(entityRoutes as any).sort([
              "static",
              "params",
              "regex",
              "wildcard",
              "global",
            ]) as any
          )
        )
      }
    }

    /**
     * CORS and Auth setup for admin routes
     */
    this.#applyCorsMiddleware(
      routesFinder,
      "/admin",
      "shouldAppendAdminCors",
      this.#createCorsOptions(configManager.config.projectConfig.http.adminCors)
    )
    this.#applyAuthMiddleware(routesFinder, "/admin", "user", [
      "bearer",
      "session",
      "api-key",
    ])

    this.#applyCorsMiddleware(
      routesFinder,
      "/store",
      "shouldAppendStoreCors",
      this.#createCorsOptions(configManager.config.projectConfig.http.storeCors)
    )
    /**
     * Publishable key check, CORS and auth setup for store routes.
     */
    this.#applyStorePublishableKeyMiddleware("/store")

    this.#applyLocaleMiddleware("/store")

    this.#applyAuthMiddleware(
      routesFinder,
      "/store",
      "customer",
      ["bearer", "session"],
      {
        allowUnauthenticated: true,
      }
    )

    /**
     * Apply CORS middleware for "/auth" routes
     */
    this.#applyCorsMiddleware(
      routesFinder,
      "/auth",
      "shouldAppendAuthCors",
      this.#createCorsOptions(configManager.config.projectConfig.http.authCors)
    )

    const collectionToSort = ([] as (MiddlewareDescriptor | RouteDescriptor)[])
      .concat(middlewares)
      .concat(routes)

    const sortedRoutes = new RoutesSorter(collectionToSort).sort()
    sortedRoutes.forEach((route) => {
      if ("isRoute" in route) {
        routesFinder.add(route)
      }
      this.#registerExpressHandler(route)
    })

    /**
     * Registering error handler as the final handler
     */
    this.#app.use(sourceErrorHandler ?? errorHandler())
  }

  /**
   * Clear all API resources registered by this loader
   * This removes all routes and middleware added after the initial stack state
   * Used by HMR to reset the API state before reloading
   */
  clearAllResources() {
    const router = this.#app._router as IRouter
    const initialStackLength =
      (global as any).__MEDUSA_HMR_INITIAL_STACK_LENGTH__ ?? 0

    if (router && router.stack) {
      router.stack.splice(initialStackLength)
    }
  }
}
