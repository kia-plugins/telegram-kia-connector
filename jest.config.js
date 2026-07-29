// Day docs group by the user's LOCAL wall-clock day (dayKey / the delta
// day-start clamp) — pin the suite's timezone so those assertions are
// deterministic on any machine.
process.env.TZ = 'UTC';
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: false }],
  },
};
