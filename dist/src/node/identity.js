import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decryptWithPassphrase, encryptWithPassphrase, fingerprint, fromUtf8, generateBoxKeys, generateSigningKeys, utf8, } from '../../shared/crypto.js';
export async function generateKeys() {
    return { sign: await generateSigningKeys(), box: await generateBoxKeys() };
}
export async function saveIdentity(path, keys, passphrase = process.env.AGENT_NETWORK_PASSPHRASE) {
    const secrets = { sign: keys.sign.private, box: keys.box.private };
    const file = {
        v: 1,
        org: keys.org,
        developer: keys.developer,
        name: keys.name,
        hub: keys.hub,
        root: keys.root,
        sign_pub: keys.sign.public,
        box_pub: keys.box.public,
        ...(passphrase ? { protected: await encryptWithPassphrase(passphrase, utf8(JSON.stringify(secrets))) } : { private: secrets }),
        created_at: new Date().toISOString(),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    try {
        chmodSync(path, 0o600);
    }
    catch {
        // Not supported on every file system (e.g. Windows); rely on the user profile's ACLs there.
    }
}
export async function loadIdentity(path, passphrase = process.env.AGENT_NETWORK_PASSPHRASE) {
    if (!existsSync(path))
        throw new Error(`Identity not found at ${path}. Run "agent-network join" or "agent-network org init" first.`);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    let secrets = file.private;
    if (!secrets && file.protected) {
        if (!passphrase)
            throw new Error('This identity is passphrase-protected: set AGENT_NETWORK_PASSPHRASE.');
        try {
            secrets = JSON.parse(fromUtf8(await decryptWithPassphrase(passphrase, file.protected)));
        }
        catch {
            throw new Error('Wrong AGENT_NETWORK_PASSPHRASE for this identity.');
        }
    }
    if (!secrets)
        throw new Error(`Identity file ${path} has no private keys.`);
    return {
        org: file.org,
        developer: file.developer,
        name: file.name,
        hub: file.hub,
        root: file.root,
        sign: { public: file.sign_pub, private: secrets.sign },
        box: { public: file.box_pub, private: secrets.box },
    };
}
export async function rootFromKeys(developer, signPub) {
    return { id: developer, sign_pub: signPub, fingerprint: await fingerprint(signPub) };
}
//# sourceMappingURL=identity.js.map