import type { PasskeyCredentialMetadata } from '@category-labs/mera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetMeQueryKey,
  registerMember,
  setAuthTokenGetter,
  useGetMe,
  type Member,
  type TransferInput,
} from '@workspace/api-client-react';
import {
  AUSD_EIP712_DOMAIN,
  AUTH_TOKEN_TTL_SECONDS,
  LIMITS,
  SESSION_POLICY,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  buildAuthMessage,
  encodeAuthToken,
} from '@workspace/gullak-core';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { toHex, type Address } from 'viem';
import { guessCountry } from '@/lib/country';
import { apiErrorStatus } from '@/lib/errors';
import { createKey, unlockKey, type UnlockedKey } from '@/lib/keys';
import { apiHost, rpId } from '@/lib/rp';

const STORAGE_KEY = 'gullak.account.v1';

/** What this device remembers between sessions. Nothing here is secret. */
export type SavedAccount = {
  address: Address;
  credential: PasskeyCredentialMetadata;
  rpId: string;
  handle?: string;
  displayName?: string;
};

export type WalletStatus = 'loading' | 'locked' | 'checking' | 'needsProfile' | 'ready' | 'error';

export type PendingProfile = { handle: string; displayName: string; error: unknown };

type WalletContextValue = {
  status: WalletStatus;
  saved: SavedAccount | null;
  address: Address | null;
  member: Member | null;
  meError: unknown;
  lockNotice: string | null;
  pendingProfile: PendingProfile | null;
  budgetLeftUnits: bigint;
  createAccount: (profile: { handle: string; displayName: string }) => Promise<void>;
  unlock: (mode: 'saved' | 'any') => Promise<void>;
  lock: (notice?: string) => void;
  forgetDevice: () => Promise<void>;
  /** Signs an AUSD transfer under the session policy; may ask for the passkey again. */
  authorizeTransfer: (to: Address, value: bigint) => Promise<{ input: TransferInput; budgeted: bigint }>;
  /** Returns budget to the session when a signed transfer was not relayed. */
  releaseBudget: (units: bigint) => void;
  needsStepUp: (value: bigint) => boolean;
  retryProfileCheck: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function randomHex(bytes: number): `0x${string}` {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

function isSavedAccount(value: unknown): value is SavedAccount {
  const v = value as SavedAccount | null;
  return !!v && typeof v.address === 'string' && typeof v.rpId === 'string' && typeof v.credential?.credentialId === 'string';
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<SavedAccount | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [spent, setSpent] = useState<bigint>(0n);
  const [lockNotice, setLockNotice] = useState<string | null>(null);
  const [pendingProfile, setPendingProfile] = useState<PendingProfile | null>(null);

  const keyRef = useRef<UnlockedKey | null>(null);
  const startedAtRef = useRef(0);
  const lastActiveRef = useRef(0);
  const tokenRef = useRef<{ token: string; expiresAt: number; address: Address } | null>(null);
  const tokenPendingRef = useRef<Promise<string> | null>(null);

  // --- device memory -------------------------------------------------------
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        // A passkey only works on the host it was made for (dev vs published).
        if (isSavedAccount(parsed) && parsed.rpId === rpId()) setSaved(parsed);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const persist = useCallback(async (account: SavedAccount | null) => {
    setSaved(account);
    if (account) await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(account));
    else await AsyncStorage.removeItem(STORAGE_KEY);
  }, []);

  // --- sign-in tokens for the API ------------------------------------------
  const getToken = useCallback(async (): Promise<string | null> => {
    const key = keyRef.current;
    if (!key) return null;
    const cached = tokenRef.current;
    if (cached && cached.address === key.account.address && cached.expiresAt - Date.now() > 60_000) {
      return cached.token;
    }
    if (!tokenPendingRef.current) {
      tokenPendingRef.current = (async () => {
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000);
        const message = buildAuthMessage({
          address: key.account.address,
          audience: apiHost(),
          issuedAt,
          expiresAt,
          nonce: randomHex(16).slice(2),
        });
        const signature = await key.account.signMessage({ message });
        const token = encodeAuthToken(message, signature);
        tokenRef.current = { token, expiresAt: expiresAt.getTime(), address: key.account.address };
        return token;
      })().finally(() => {
        tokenPendingRef.current = null;
      });
    }
    return tokenPendingRef.current;
  }, []);

  useEffect(() => {
    setAuthTokenGetter(getToken);
    return () => setAuthTokenGetter(null);
  }, [getToken]);

  // --- session lifecycle ---------------------------------------------------
  const openSession = useCallback((key: UnlockedKey) => {
    keyRef.current?.session.end();
    keyRef.current = key;
    tokenRef.current = null;
    startedAtRef.current = Date.now();
    lastActiveRef.current = Date.now();
    setSpent(0n);
    setLockNotice(null);
  }, []);

  const lock = useCallback(
    (notice?: string) => {
      keyRef.current?.session.end();
      keyRef.current = null;
      tokenRef.current = null;
      setAddress(null);
      setSpent(0n);
      setPendingProfile(null);
      setLockNotice(notice ?? null);
      queryClient.clear();
    },
    [queryClient],
  );

  useEffect(() => {
    if (!address) return;
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - lastActiveRef.current > SESSION_POLICY.idleMs) {
        lock('Locked after 10 minutes without activity.');
      } else if (now - startedAtRef.current > SESSION_POLICY.maxAgeMs) {
        lock('Locked after 30 minutes. Unlock to keep going.');
      }
    }, 10_000);
    let backgroundedAt: number | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        backgroundedAt = Date.now();
      } else if (state === 'active' && backgroundedAt !== null) {
        const away = Date.now() - backgroundedAt;
        backgroundedAt = null;
        if (away > SESSION_POLICY.backgroundGraceMs) lock('Locked while Gullak was in the background.');
      }
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [address, lock]);

  const markActive = useCallback(() => {
    lastActiveRef.current = Date.now();
    return false;
  }, []);

  // --- profile -------------------------------------------------------------
  const me = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      enabled: address !== null,
      staleTime: 5 * 60_000,
      retry: (count, err) => {
        const status = apiErrorStatus(err);
        return status !== 404 && status !== 401 && count < 2;
      },
    },
  });

  const member = address && me.data && me.data.address === address ? me.data : null;

  useEffect(() => {
    if (!member || !saved || saved.address !== member.address) return;
    if (saved.handle === member.handle && saved.displayName === member.displayName) return;
    void persist({ ...saved, handle: member.handle, displayName: member.displayName });
  }, [member, saved, persist]);

  let status: WalletStatus;
  if (!loaded) status = 'loading';
  else if (!address) status = 'locked';
  else if (member) status = 'ready';
  else if (me.error) status = apiErrorStatus(me.error) === 404 ? 'needsProfile' : 'error';
  else status = 'checking';

  // --- actions -------------------------------------------------------------
  const createAccount = useCallback(
    async (profile: { handle: string; displayName: string }) => {
      const key = await createKey(`@${profile.handle}`);
      openSession(key);
      const account = key.account.address;
      await persist({
        address: account,
        credential: key.credential,
        rpId: rpId(),
        handle: profile.handle,
        displayName: profile.displayName,
      });
      // Register before revealing the session, so the profile screen never flashes.
      try {
        const created = await registerMember({
          handle: profile.handle,
          displayName: profile.displayName,
          country: guessCountry(),
        });
        queryClient.setQueryData(getGetMeQueryKey(), created);
        setPendingProfile(null);
      } catch (err) {
        setPendingProfile({ ...profile, error: err });
      }
      setAddress(account);
    },
    [openSession, persist, queryClient],
  );

  const unlock = useCallback(
    async (mode: 'saved' | 'any') => {
      const credential = mode === 'saved' && saved ? saved.credential : undefined;
      const key = await unlockKey(credential);
      openSession(key);
      const account = key.account.address;
      const same = saved?.address === account;
      await persist({
        address: account,
        credential: key.credential,
        rpId: rpId(),
        ...(same && saved?.handle ? { handle: saved.handle } : {}),
        ...(same && saved?.displayName ? { displayName: saved.displayName } : {}),
      });
      setAddress(account);
    },
    [openSession, persist, saved],
  );

  const forgetDevice = useCallback(async () => {
    lock();
    await persist(null);
  }, [lock, persist]);

  const needsStepUp = useCallback((value: bigint) => spent + value > SESSION_POLICY.budgetUnits, [spent]);

  const authorizeTransfer = useCallback(
    async (to: Address, value: bigint) => {
      let key = keyRef.current;
      if (!key) throw new Error('Gullak is locked. Unlock to send.');
      let budgeted = value;
      if (spent + value > SESSION_POLICY.budgetUnits) {
        // Fresh user verification for sends beyond the quick-send budget.
        const fresh = await unlockKey(key.credential);
        if (fresh.account.address !== key.account.address) {
          fresh.session.end();
          throw new Error('That passkey belongs to a different Gullak account.');
        }
        openSession(fresh);
        key = fresh;
        budgeted = 0n;
      }
      lastActiveRef.current = Date.now();
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + LIMITS.transferValiditySeconds);
      const nonce = randomHex(32);
      const from = key.account.address;
      const signature = await key.account.signTypedData({
        domain: AUSD_EIP712_DOMAIN,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: { from, to, value, validAfter: 0n, validBefore, nonce },
      });
      if (budgeted > 0n) setSpent((s) => s + budgeted);
      return {
        input: {
          from,
          to,
          value: value.toString(),
          validAfter: 0,
          validBefore: Number(validBefore),
          nonce,
          signature,
        },
        budgeted,
      };
    },
    [openSession, spent],
  );

  const releaseBudget = useCallback((units: bigint) => {
    if (units > 0n) setSpent((s) => (s > units ? s - units : 0n));
  }, []);

  const retryProfileCheck = useCallback(() => {
    void me.refetch();
  }, [me]);

  const budgetLeftUnits = SESSION_POLICY.budgetUnits > spent ? SESSION_POLICY.budgetUnits - spent : 0n;

  const value: WalletContextValue = {
    status,
    saved,
    address,
    member,
    meError: me.error,
    lockNotice,
    pendingProfile,
    budgetLeftUnits,
    createAccount,
    unlock,
    lock,
    forgetDevice,
    authorizeTransfer,
    releaseBudget,
    needsStepUp,
    retryProfileCheck,
  };

  return (
    <WalletContext.Provider value={value}>
      <View style={{ flex: 1 }} onStartShouldSetResponderCapture={markActive}>
        {children}
      </View>
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider');
  return ctx;
}
