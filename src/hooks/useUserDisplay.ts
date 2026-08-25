/**
 * useUserDisplay — resolve display name and avatar for an address.
 *
 * Checks: (1) own address from context, (2) local cache, (3) API profile.
 * Returns immediately with cached data, fetches from API in background.
 */

import { useState, useEffect } from 'react';
import { useConnection } from '../context/ConnectionContext';
import { getCachedUser, setCachedUser } from '../lib/userCache';
import { getSetting } from '../lib/settings';

interface UserDisplay {
  displayName: string | null;
  avatarUri: string | null;
}

/** Track which addresses we've already fetched from API to avoid re-fetching */
const apiFetched = new Set<string>();

export function useUserDisplay(address: string | undefined): UserDisplay {
  const { address: myAddress, displayName: myName, client } = useConnection();
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

    // Check local cache first.
    //
    // This branch used to hardcode `avatarUri: null` while `setCachedUser` below
    // faithfully stored the `avatarCid` — so the cache held the avatar and the
    // read path threw it away. Combined with the `apiFetched` guard (which never
    // clears, so an address is fetched at most once per session), the first card
    // for a user showed their avatar and every later one fell back to the letter
    // circle. In a FlatList that recycles cards constantly, that meant the news
    // feed effectively never showed avatars, while the profile screen — which
    // fetches directly — always did.
    getCachedUser(address).then((user) => {
      if (user?.displayName || user?.avatarCid) {
        setCached({
          displayName: user.displayName ?? null,
          avatarUri: user.avatarCid && client ? client.getMediaUrl(user.avatarCid) : null,
        });
      }
    });

    // Fetch from API if not already fetched this session
    if (client && !apiFetched.has(address)) {
      apiFetched.add(address);
      client.getUserProfile(address).then((resp: any) => {
        const user = resp?.user;
        if (user?.display_name) {
          const name = user.display_name;
          const avatarCid = user.avatar_cid;
          setCached({
            displayName: name,
            avatarUri: avatarCid ? client.getMediaUrl(avatarCid) : null,
          });
          // Update local cache for future use
          setCachedUser(address, { displayName: name, avatarCid: avatarCid || null });
        }
      }).catch(() => {});
    }
  }, [address, myAddress, myName, client]);

  // Fast path: own address
  if (address === myAddress && myName) {
    return { displayName: myName, avatarUri: cached.avatarUri };
  }

  return cached;
}
