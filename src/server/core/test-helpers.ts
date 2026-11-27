import { signUp } from "./accounts";
import { openDb, type Db } from "./db";
import { requireMembership, type Membership } from "./workspaces";

export const freshDb = () => openDb("memory://");

let n = 0;
export async function makeUser(db: Db, name = "User") {
  n += 1;
  return signUp(db, { email: `${name.toLowerCase()}${n}@example.test`, name, password: "correct horse battery" });
}

export const asMember = (db: Db, userId: string, slug: string): Promise<Membership> =>
  requireMembership(db, userId, slug);
