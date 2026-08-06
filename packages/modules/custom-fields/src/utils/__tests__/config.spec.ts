import { resolveDefinitions } from "../config"

const options = (fields: Record<string, any>) => ({ fields: { brand: fields } })

describe("resolveDefinitions", () => {
  it("resolves definitions with defaults applied and keys sorted", () => {
    const byEntity = resolveDefinitions(
      options({
        rating: { type: "float" },
        country: { type: "text", required: true },
      })
    )

    const definitions = byEntity.get("brand")!
    expect(definitions.map((d) => d.key)).toEqual(["country", "rating"])
    expect(definitions[0]).toEqual(
      expect.objectContaining({
        entity: "brand",
        key: "country",
        required: true,
        indexed: false,
      })
    )
  })

  it("rejects a reserved key", () => {
    expect(() =>
      resolveDefinitions(options({ deleted_at: { type: "text" } }))
    ).toThrow(/reserved key/)
  })

  it("rejects an unknown type", () => {
    expect(() =>
      resolveDefinitions(options({ tier: { type: "varchar" } }))
    ).toThrow(/unknown type/)
  })

  it("requires choices on enums and rejects them elsewhere", () => {
    expect(() => resolveDefinitions(options({ tier: { type: "enum" } }))).toThrow(
      /must declare "choices"/
    )
    expect(() =>
      resolveDefinitions(options({ name: { type: "text", choices: ["a"] } }))
    ).toThrow(/declares "choices" but is not an enum/)
  })

  describe("default_value", () => {
    it("accepts a type-valid default", () => {
      const byEntity = resolveDefinitions(
        options({
          warranty_months: { type: "number", default_value: 12 },
          tier: {
            type: "enum",
            choices: ["standard", "premium"],
            required: true,
            default_value: "standard",
          },
        })
      )

      const byKey = new Map(
        byEntity.get("brand")!.map((d) => [d.key, d.default_value])
      )
      expect(byKey.get("warranty_months")).toEqual(12)
      expect(byKey.get("tier")).toEqual("standard")
    })

    it("rejects a default that is not valid for the type, at boot", () => {
      expect(() =>
        resolveDefinitions(
          options({ warranty_months: { type: "number", default_value: "abc" } })
        )
      ).toThrow(/invalid default_value: .*expects a number/)

      expect(() =>
        resolveDefinitions(
          options({ warranty_months: { type: "number", default_value: 1.5 } })
        )
      ).toThrow(/default_value/)
    })

    it("rejects an enum default outside its choices", () => {
      expect(() =>
        resolveDefinitions(
          options({
            tier: {
              type: "enum",
              choices: ["standard", "premium"],
              default_value: "gold",
            },
          })
        )
      ).toThrow(/invalid default_value: .*expects one of: standard, premium/)
    })
  })

  describe("date type", () => {
    it("accepts an ISO date default and rejects time-bearing values", () => {
      const byEntity = resolveDefinitions(
        options({ founded_on: { type: "date", default_value: "1947-06-01" } })
      )
      expect(byEntity.get("brand")![0].default_value).toEqual("1947-06-01")

      expect(() =>
        resolveDefinitions(
          options({
            founded_on: {
              type: "date",
              default_value: "1947-06-01T10:00:00Z",
            },
          })
        )
      ).toThrow(/ISO date \(YYYY-MM-DD, no time component\)/)
    })

    it("rejects a date that only looks like one", () => {
      expect(() =>
        resolveDefinitions(
          options({ founded_on: { type: "date", default_value: "1947-02-30" } })
        )
      ).toThrow(/ISO date/)
    })
  })

  describe("min/max", () => {
    it("accepts bounds on bounded types and enforces them on defaults", () => {
      const byEntity = resolveDefinitions(
        options({
          warranty_months: { type: "number", min: 0, max: 120, default_value: 12 },
        })
      )
      expect(byEntity.get("brand")![0]).toEqual(
        expect.objectContaining({ min: 0, max: 120 })
      )

      expect(() =>
        resolveDefinitions(
          options({
            warranty_months: { type: "number", min: 0, max: 120, default_value: 240 },
          })
        )
      ).toThrow(/invalid default_value: .*at most 120/)
    })

    it("rejects bounds on unbounded types", () => {
      expect(() =>
        resolveDefinitions(options({ name: { type: "text", min: 1 } }))
      ).toThrow(/not bounded/)
    })

    it("rejects malformed and inverted bounds", () => {
      expect(() =>
        resolveDefinitions(
          options({ warranty_months: { type: "number", min: 1.5 } })
        )
      ).toThrow(/min that is not an integer/)

      expect(() =>
        resolveDefinitions(
          options({ rating: { type: "float", min: 5, max: 1 } })
        )
      ).toThrow(/min greater than max/)

      expect(() =>
        resolveDefinitions(
          options({ founded_on: { type: "date", min: "junk" } })
        )
      ).toThrow(/min that is not an ISO date/)
    })

    it("accepts date and dateTime bounds", () => {
      const byEntity = resolveDefinitions(
        options({
          founded_on: { type: "date", min: "1900-01-01", max: "2100-01-01" },
          launched_at: {
            type: "dateTime",
            min: "2000-01-01T00:00:00Z",
            max: "2100-01-01T00:00:00Z",
          },
        })
      )
      expect(byEntity.get("brand")).toHaveLength(2)
    })
  })

  describe("readonly", () => {
    it("defaults to false and rejects required+readonly without a default", () => {
      const byEntity = resolveDefinitions(options({ name: { type: "text" } }))
      expect(byEntity.get("brand")![0].readonly).toEqual(false)

      expect(() =>
        resolveDefinitions(
          options({ sync_hash: { type: "text", required: true, readonly: true } })
        )
      ).toThrow(/required and readonly but has no default_value/)

      // A default satisfies the combination.
      const withDefault = resolveDefinitions(
        options({
          sync_hash: {
            type: "text",
            required: true,
            readonly: true,
            default_value: "none",
          },
        })
      )
      expect(withDefault.get("brand")![0].readonly).toEqual(true)
    })
  })

  describe("rank", () => {
    it("orders by rank ascending with key breaking ties, default 0", () => {
      const byEntity = resolveDefinitions(
        options({
          zeta: { type: "text" },
          alpha: { type: "text" },
          first: { type: "text", rank: -1 },
          last: { type: "text", rank: 10 },
        })
      )
      expect(byEntity.get("brand")!.map((d) => d.key)).toEqual([
        "first",
        "alpha",
        "zeta",
        "last",
      ])
    })

    it("rejects a non-numeric rank", () => {
      expect(() =>
        resolveDefinitions(options({ name: { type: "text", rank: "high" } }))
      ).toThrow(/non-numeric rank/)
    })
  })

  describe("restricted", () => {
    it("defaults to false and resolves when set", () => {
      const byEntity = resolveDefinitions(
        options({
          name: { type: "text" },
          margin: { type: "float", restricted: true },
        })
      )
      const byKey = new Map(byEntity.get("brand")!.map((d) => [d.key, d]))
      expect(byKey.get("name")!.restricted).toEqual(false)
      expect(byKey.get("margin")!.restricted).toEqual(true)
    })
  })
})
