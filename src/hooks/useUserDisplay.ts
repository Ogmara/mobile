/**
 * useUserDisplay — resolve display name and avatar for an address.
 *
 * Checks: (1) own address from context, (2) local cache, (3) API (future).
 * Returns immediately with cached data, does not block rendering.
 */

import { useState, useEffect } from 'react';
import { useConnection } from '../context/ConnectionContext';
import { getCachedUser } from '../lib/userCache';
import { getSetting } from '../lib/settings';

interface UserDisplay {
  displayName: string | null;
  avatarUri: string | null;
}

export function useUserDisplay(address: string | undefined): UserDisplay {
  const { address: myAddress, displayName: myName } = useConnection();
  const [cached, setCached] = useState<UserDisplay>({ displayName: null, avatarUri: null });

  useEffect(() => {
    if (!address) return;

    // Own address — use context + local avatar
    if (address === myAddress) {
      getSetting('avatarLocalUri').then((uri) => {
        setCached({ displayName: myName, avatarUri: uri });
      });
      return;
    }

    // Check local cache for other users
    getCachedUser(address).then((user) => {
      if (user?.displayName) {
        setCached({ displayName: user.displayName, avatarUri: null });
      }
    });
  }, [address, myAddress, myName]);

  // Fast path: own address
  if (address === myAddress && myName) {
    return { displayName: myName, avatarUri: cached.avatarUri };
  }

  return cached;
}
