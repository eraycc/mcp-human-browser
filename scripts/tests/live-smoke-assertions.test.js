const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertSmokeResults
} = require('../live-smoke-assertions');

const healthy = {
  listenerBefore: false,
  listenerAfterInitialize: false,
  listenerDuring: true,
  listenerAfterExit: false,
  webdriver: false,
  pageIdRequired: true,
  unknownArgumentWarning: false
};

test('live smoke accepts the required lazy visible-browser invariants', () => {
  assert.doesNotThrow(() => assertSmokeResults(healthy));
});

test('live smoke rejects webdriver automation and lifecycle regressions', () => {
  assert.throws(
    () => assertSmokeResults({
      ...healthy,
      listenerDuring: false,
      webdriver: true
    }),
    /listenerDuring must be true.*navigator\.webdriver must be false/
  );
});
