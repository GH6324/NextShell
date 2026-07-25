import {
  KeychainAccessDeniedError,
  resolveDeviceKey,
  type DeviceKeyDbAccess,
  type DeviceKeyStore
} from "../../../../../packages/security/src/index";
import { logger } from "../logger";

export type DeviceKeyStatus = "unresolved" | "keychain" | "database" | "denied";

export interface DeviceKeyProviderOptions {
  store: DeviceKeyStore;
  db: DeviceKeyDbAccess;
  /**
   * Awaited immediately before the first real keychain read, so the app can
   * explain the OS authorization prompt that is about to appear. Never called
   * again once the key has been resolved.
   */
  onBeforeKeychainAccess?: () => Promise<void>;
}

/**
 * Resolves the device key on first use rather than at startup.
 *
 * On macOS every keychain read whose ACL does not match the running binary pops
 * an authorization dialog, so reading eagerly means interrupting every launch —
 * including launches that never touch a stored credential (local shells, agent
 * based SSH). Deferring it also puts the prompt in a context the user can make
 * sense of: it appears while connecting to a host, not before the window opens.
 *
 * A denial is sticky for the session: re-prompting on every subsequent
 * credential read would be worse than failing cleanly. `reauthorize()` clears it
 * for users who denied by accident.
 */
export class DeviceKeyProvider {
  private resolved: Buffer | undefined;
  private inFlight: Promise<Buffer> | undefined;
  private denied: KeychainAccessDeniedError | undefined;
  private status: DeviceKeyStatus = "unresolved";

  constructor(private readonly options: DeviceKeyProviderOptions) {}

  getStatus(): DeviceKeyStatus {
    return this.status;
  }

  async get(): Promise<Buffer> {
    if (this.resolved) {
      return this.resolved;
    }
    if (this.denied) {
      throw this.denied;
    }
    this.inFlight ??= this.resolve();
    return this.inFlight;
  }

  /** Drop a sticky denial so the next credential access asks the OS again. */
  reauthorize(): void {
    this.denied = undefined;
    this.inFlight = undefined;
    if (!this.resolved) {
      this.status = "unresolved";
    }
  }

  private async resolve(): Promise<Buffer> {
    try {
      if (this.options.onBeforeKeychainAccess && this.options.store.isAvailable()) {
        await this.options.onBeforeKeychainAccess();
      }

      const result = await resolveDeviceKey(this.options.store, this.options.db);
      if (result.storedIn === "keychain") {
        logger.info(
          result.migratedFromDatabase
            ? "[Security] migrated device key from database to system keychain"
            : "[Security] device key resolved from system keychain"
        );
      } else {
        logger.warn(
          "[Security] system keychain unavailable; device key stored in local database (degraded)"
        );
      }

      this.resolved = Buffer.from(result.deviceKeyHex, "hex");
      this.status = result.storedIn;
      return this.resolved;
    } catch (error) {
      if (error instanceof KeychainAccessDeniedError) {
        this.denied = error;
        this.status = "denied";
        logger.warn("[Security] keychain authorization denied; stored credentials unavailable");
      }
      throw error;
    } finally {
      this.inFlight = undefined;
    }
  }
}
