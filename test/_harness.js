'use strict'

// Tests and banners run in order once the file has registered them; a test may be
// async. The first failure stops the file with a non-zero exit code.
const steps = []
let scheduled = false

function schedule () {
  if (scheduled) return
  scheduled = true
  setImmediate(async () => {
    for (const step of steps) {
      if (step.label) {
        console.log(`\n# ${step.label}`)
        continue
      }
      try {
        await step.fn()
        console.log(`\x1b[32mok\x1b[0m - ${step.name}`)
      } catch (err) {
        console.error(`\x1b[31mnot ok\x1b[0m - ${step.name}`)
        console.error(err)
        process.exit(1)
      }
    }
  })
}

function test(name, fn) {
  steps.push({ name, fn })
  schedule()
}

function banner(label) {
  steps.push({ label })
  schedule()
}

module.exports = {
  test,
  banner,
}
