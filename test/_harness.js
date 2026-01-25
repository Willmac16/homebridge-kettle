'use strict'

function test(name, fn) {
  try {
    fn()
    console.log(`\x1b[32mok\x1b[0m - ${name}`)
  } catch (err) {
    console.error(`\x1b[31mnot ok\x1b[0m - ${name}`)
    throw err
  }
}

function banner(label) {
  console.log(`\n# ${label}`)
}

module.exports = {
  test,
  banner,
}
