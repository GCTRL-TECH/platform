import { User } from './models/user'
import * as util from './util'
import fs from 'node:fs'
export function main() { const u = new User(); u.greet(util.add(1, 2)); fs.existsSync('x') }
