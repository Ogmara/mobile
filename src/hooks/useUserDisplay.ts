/**
 * useUserDisplay — resolve display name and avatar for an address.
 *
 * Checks: (1) own address from context, (2) local cache, (3) API (future).
 * Returns immediately with cached data, does not block rendering.
 */

import { useState, useEffect } from 'react';
import { useConnection } from '../context/ConnectionContext';
import { getCachedUser } from '../lib/userCache';

interface UserDisplay {
  displayName: string | null;
  avatarCid: string | null;
}

export function useUserDisplay(address: string | undefined): UserDisplay {
  const { address: myAddress, displayName: myName } = useConnection();
  const [cached, setCached] = useState<UserDisplay>({ displayName: null, avatarCid: null });

  useEffect(() => {
    if (!address) return;

    // Own address — use context
    if (address === myAddress && myName) {
      setCached({ displayName: myName, avatarCid: null });
      return;
    }

    // Check local cache
    getCachedUser(address).then((user) => {
      if (user?.displayName) {
        setCached({ displayName: user.displayName, avatarCid: user.avatarCid });
      }
    });
  }, [address, myAddress, myName]);

  // Fast path: own address
  if (address === myAddress && myName) {
    return { displayName: myName, avatarCid: null };
  }

  return cached;
}
