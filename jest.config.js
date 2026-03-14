module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js', '**/*.spec.js'],
  collectCoverageFrom: ['orchestrator/**/*.js', '!orchestrator/**/*.test.js', '!**/node_modules/**'],
  coverageProvider: 'v8',
  coverageThreshold: { global: { lines: 80, functions: 80, branches: 70, statements: 80 } },
  coverageReporters: ['text', 'json', 'lcov'],
  verbose: true,
};
