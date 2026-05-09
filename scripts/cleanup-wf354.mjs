// scripts/cleanup-wf354.mjs
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccount = JSON.parse(
  readFileSync(new URL("../serviceAccount.json", import.meta.url), "utf8")
);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const WORKSPACE_ID = "WF-354";

async function main() {
  console.log(`\n=== Cleanup for workspace ${WORKSPACE_ID} ===\n`);

  const wsRef = db.doc(`workspaces/${WORKSPACE_ID}`);
  const wsSnap = await wsRef.get();
  if (!wsSnap.exists) {
    console.error(`❌ Workspace ${WORKSPACE_ID} does not exist. Aborting.`);
    process.exit(1);
  }
  const wsData = wsSnap.data();
  const ownerUserId = wsData.ownerUserId;
  console.log(`Workspace owner: ${ownerUserId}`);
  console.log(`externalGuestLimit: ${wsData.externalGuestLimit ?? 0}\n`);

  const peopleSnap = await db.collection(`workspaces/${WORKSPACE_ID}/people`).get();
  console.log(`Found ${peopleSnap.size} docs in /people:`);
  peopleSnap.forEach((d) => {
    const p = d.data();
    console.log(`  • ${d.id}  type=${p.type ?? "?"}  email=${p.email ?? "?"}  role=${p.role ?? "?"}`);
  });
  console.log();

  let fixed = 0;
  const legitimateGuests = [];
  for (const doc of peopleSnap.docs) {
    const p = doc.data();
    const uid = p.userId || p.uid || doc.id;
    if (!uid) continue;

    const userRef = db.doc(`users/${uid}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      console.log(`  ⚠ users/${uid} missing — skipping`);
      continue;
    }
    const u = userSnap.data();

    if (u.workspaceId === WORKSPACE_ID && uid !== ownerUserId) {
      const personalId = `WF-PERSONAL-${uid}`;
      console.log(`  🔧 Fixing users/${uid}.workspaceId: ${WORKSPACE_ID} → ${personalId}`);

      const personalRef = db.doc(`workspaces/${personalId}`);
      const personalSnap = await personalRef.get();
      if (!personalSnap.exists) {
        await personalRef.set({
          workspaceId: personalId,
          name: `${u.displayName ?? u.email ?? "User"}'s Workspace`,
          ownerUserId: uid,
          createdAt: new Date(),
          externalGuestLimit: 0,
          isPersonal: true,
        });
        console.log(`     created workspaces/${personalId}`);
      }

      await userRef.update({ workspaceId: personalId });
      fixed++;
    }

    if (p.type === "external_guest") {
      legitimateGuests.push({ uid, email: p.email, role: p.role });
    }
  }

  console.log(`\n✅ Repaired workspaceId for ${fixed} user(s).`);
  console.log(`\nLegitimate external guests remaining in ${WORKSPACE_ID}/people:`);
  if (legitimateGuests.length === 0) {
    console.log("  (none)");
  } else {
    legitimateGuests.forEach((g) =>
      console.log(`  • ${g.uid}  ${g.email ?? "?"}  role=${g.role ?? "?"}`)
    );
  }

  console.log("\n=== Done ===\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
