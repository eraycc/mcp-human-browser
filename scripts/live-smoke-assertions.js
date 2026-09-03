'use strict';

function collectSmokeFailures(result) {
  const checks = [
    ['listenerBefore must be false', result.listenerBefore === false],
    ['listenerAfterInitialize must be false', result.listenerAfterInitialize === false],
    ['listenerDuring must be true', result.listenerDuring === true],
    ['navigator.webdriver must be false', result.webdriver === false],
    ['pageIdRequired must be true', result.pageIdRequired === true],
    ['unknownArgumentWarning must be false', result.unknownArgumentWarning === false],
    ['explicitClose must be true', result.explicitClose === true],
    ['listenerAfterExit must be false', result.listenerAfterExit === false],
  ];

  return checks.filter(([, passed]) => !passed).map(([message]) => message);
}

function assertSmokeResults(result) {
  const failures = collectSmokeFailures(result);
  if (failures.length > 0) {
    throw new Error(`LIVE_SMOKE_FAILED: ${failures.join('; ')}`);
  }
}

module.exports = {
  assertSmokeResults,
  collectSmokeFailures,
};
