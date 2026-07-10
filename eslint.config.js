// Flat config. Type-aware rules on all TS projects; async-correctness rules
// are the point (floating promise in custody spine = dropped state transition).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "bench/results/**",
      "eslint.config.js",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts", "packages/*/test/*.ts"],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 40,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Async correctness — custody spine is await-heavy; a dropped promise is
      // a silently-skipped store transition.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Interface-conformance async methods (store contract) legitimately have
      // no await; the async-correctness value lives in the three rules above.
      "@typescript-eslint/require-await": "off",
      // Guard parses untrusted payloads; keep escape hatches visible but legal.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests drive the guard through deliberately duck-typed fakes; unsafe-any
    // ceremony there adds noise, not safety. Async rules stay on.
    files: ["packages/*/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
