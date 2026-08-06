const defineJestConfig = require("../../../define_jest_config")
module.exports = defineJestConfig({
  moduleNameMapper: {
    "^@/types$": "<rootDir>/src/types",
    "^@/services$": "<rootDir>/src/services",
    "^@/utils$": "<rootDir>/src/utils",
    "^@models": "<rootDir>/src/models",
    "^@services": "<rootDir>/src/services",
    "^@repositories": "<rootDir>/src/repositories",
    "^@types": "<rootDir>/src/types",
    "^@utils": "<rootDir>/src/utils",
  },
})
