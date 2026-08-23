import { add } from '../util.js'
export class Base { id = 0 }
export class User extends Base implements Printable {
  /** Greets. */
  greet(n: number) { return add(n, 1) + this.shout() }
  private shout() { return 'hi' }
}
export interface Printable { print(): void }
