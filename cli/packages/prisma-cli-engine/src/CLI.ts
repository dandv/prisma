import * as path from 'path'
import { Command } from './Command'
import { Config } from './Config'
import { Output } from './Output'
import { RunOptions } from './types/common'
import Lock from './Plugin/Lock'
import { Dispatcher } from './Dispatcher/Dispatcher'
import { NotFound } from './NotFound'
import fs from './fs'
import { getCommandId } from './util'
import { getFid, initStatusChecker, getStatusChecker } from './StatusChecker'
import * as updateNotifier from 'update-notifier'
import chalk from 'chalk'
import * as Raven from 'raven'
import * as os from 'os'
import * as jwt from 'jsonwebtoken'
import { getIsGlobal } from './utils/isGlobal'
import { CommandReplacedError } from './errors/CommandReplacedError'

Raven.config(
  'https://1e57780fb0bb4b52938cbb3456268121:fc6a6c6fd8cd4bbf81e2cd5c7c814a49@sentry.io/271168',
).install()

const debug = require('debug')('cli')
const handleEPIPE = err => {
  Raven.captureException(err)
  if (err.code !== 'EPIPE') {
    throw err
  }
}

let out: Output
if (!global.testing) {
  process.once('SIGINT', () => {
    if (out) {
      if (out.action.task) {
        out.action.stop(out.color.red('ctrl-c'))
      }
      out.exit(1)
    } else {
      process.exit(1)
    }
  })
  const handleErr = async err => {
    if (!out) {
      throw err
    }
    out.error(err)
  }
  process.once('uncaughtException', handleErr)
  process.once('unhandledRejection', handleErr)
  process.stdout.on('error', handleEPIPE)
  process.stderr.on('error', handleEPIPE)
}

process.env.CLI_ENGINE_VERSION = require('../package.json').version

export class CLI {
  config: Config
  cmd: Command
  notifier: any

  constructor({ config }: { config?: RunOptions } = {}) {
    if (!config) {
      config = {
        mock: false,
      }
    }
    const parentFilename = module.parent!.parent!
      ? module.parent!.parent!.filename
      : module.parent!.filename
    if (!config.initPath) {
      config.initPath = parentFilename
    }
    if (!config.root) {
      const findUp = require('find-up')
      config.root = path.dirname(
        findUp.sync('package.json', {
          cwd: parentFilename,
        }),
      )
    }
    this.config = new Config(config)
    this.notifier = updateNotifier({
      pkg: this.config.pjson,
      updateCheckInterval: 1,
    })
    this.initRaven()
  }

  async run() {
    initStatusChecker(this.config)

    out = new Output(this.config)

    this.config.setOutput(out)

    if (this.cmdAskingForHelp) {
      debug('command asking for help')
      this.cmd = await this.Help.run(this.config)

      const checker = getStatusChecker()!
      checker.checkStatus(
        this.config.argv[1],
        this.cmd.args,
        this.cmd.flags,
        this.cmd.argv,
      )
    } else {
      const id = getCommandId(this.config.argv.slice(1))
      debug('command id', id)
      // if there is a subcommand, cut the first away so the Parser still works correctly
      if (
        this.config.argv[1] &&
        this.config.argv[1].startsWith('-') &&
        id !== 'help' &&
        id !== 'init'
      ) {
        this.config.argv = this.config.argv.slice(1)
      }
      const dispatcher = new Dispatcher(this.config)
      let result = await dispatcher.findCommand(
        id || this.config.defaultCommand || 'help',
      )
      // if nothing is found, try again with taking what is before :
      if (!result.Command && id && id.includes(':')) {
        result = await dispatcher.findCommand(id.split(':')[0])
      }
      const { plugin } = result
      const foundCommand = result.Command

      if (foundCommand) {
        const lock = new Lock(out)
        await lock.unread()
        // TODO remove this
        if (process.env.NOCK_WRITE_RESPONSE_CLI === 'true') {
          debug('RECORDING')
          require('nock').recorder.rec({
            dont_print: true,
          })
        }

        this.cmd = await foundCommand.run(this.config)
        if (foundCommand.deprecated) {
          this.cmd.out.log(
            chalk.yellow(
              `\nThis command is deprecated and will be removed in 1.9`,
            ),
          )
        }
        this.setRavenUserContext()
        const checker = getStatusChecker()!
        checker.checkStatus(
          foundCommand.command ? id : id.split(':')[0],
          this.cmd.args,
          this.cmd.flags,
          this.cmd.argv,
        )

        if (process.env.NOCK_WRITE_RESPONSE_CLI === 'true') {
          const requests = require('nock').recorder.play()
          const requestsPath = path.join(process.cwd(), 'requests.js')
          debug('WRITING', requestsPath)
          fs.writeFileSync(requestsPath, requests.join('\n'))
        }
      } else {
        const topic = await dispatcher.findTopic(id)
        if (topic) {
          await this.Help.run(this.config)
          const checker = getStatusChecker()!
          checker.checkStatus(id, {}, {}, [])
        } else if (id === 'logs') {
          throw new CommandReplacedError('logs', 'cluster logs')
        } else if (id === 'push') {
          throw new CommandReplacedError('push', 'deploy')
        } else if (id === 'seed') {
          throw new CommandReplacedError('seed', 'import')
        } else if (id === 'cluster:info') {
          throw new CommandReplacedError('cluster info', 'cluster list')
        } else if (id === 'local:down') {
          throw new CommandReplacedError('local down', 'local nuke')
        } else {
          return new NotFound(out, this.config.argv).run()
        }
      }
    }

    if (this.notifier.update) {
      this.notifier.notify({
        message:
          'Update available ' +
          chalk.dim(this.notifier.update.current) +
          chalk.reset(' → ') +
          chalk.cyan(this.notifier.update.latest) +
          `\nRun ${chalk.bold.cyan('npm i -g prisma')} to update`,
        boxenOpts: {
          padding: 1,
          margin: 1,
          align: 'center',
          borderColor: 'grey',
          borderStyle: 'round',
        },
      })
    }

    if (
      !(
        this.config.argv.includes('playground') ||
        this.config.argv.includes('logs') ||
        this.config.argv.includes('logs:function') ||
        (this.config.argv.includes('deploy') &&
          (this.config.argv.includes('-w') ||
            this.config.argv.includes('--watch')))
      )
    ) {
      const { timeout } = require('./util')
      await timeout(this.flush(), 1000)

      out.exit(0)
    } else {
      debug('not flushing')
    }
  }

  initRaven() {
    Raven.setContext({
      user: {
        fid: getFid(),
        isGlobal: getIsGlobal(),
      },
      tags: {
        version: this.config.version,
        platform: os.platform(),
        argv: process.argv.slice(1),
      },
    })
    debug({ isGlobal: getIsGlobal() })
  }

  setRavenUserContext() {
    if (this.cmd && this.cmd.env && this.cmd.env.cloudSessionKey) {
      const data = jwt.decode(this.cmd.env.cloudSessionKey)
      Raven.mergeContext({
        user: {
          fid: getFid(),
          id: data.userId,
          isGlobal: getIsGlobal(),
        },
      })
    }
  }

  flush(): Promise<{} | void> {
    if (global.testing) {
      return Promise.resolve()
    }
    const p = new Promise(resolve => process.stdout.once('drain', resolve))
    process.stdout.write('')
    return p
  }

  get cmdAskingForHelp(): boolean {
    for (const arg of this.config.argv) {
      if (['--help', '-h'].includes(arg)) {
        return true
      }
      if (arg === '--') {
        return false
      }
    }
    return false
  }

  get Help() {
    const { default: Help } = require('./commands/help')
    return Help
  }
}

export function run({ config }: { config?: RunOptions } = {}) {
  if (!config) {
    config = {
      mock: false,
    }
  }

  Raven.context(() => {
    const cli = new CLI({ config })
    return cli.run()
  })
}
