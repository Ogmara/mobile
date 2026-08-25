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

    // Own address — context name, then the locally-picked avatar file.
    //
    // The local file is only there if you chose an avatar ON THIS DEVICE. Set it
    // from web or desktop and mobile had nothing, so your own posts fell back to
    // the letter circle while every other client showed the picture. Fall through
    // to the node's `avatar_cid` in that case, exactly as for any other user.
    if (address === myAddress) {
      getSetting('avatarLocalUri').then((uri) => {
        if (uri) {
          setCached({ displayName: myName, avatarUri: uri });
          return;
        }
        getCachedUser(address).then((user) => {
          setCached({
            displayName: myName ?? user?.displayName ?? null,
            avatarUri: user?.avatarCid && client ? client.getMediaUrl(user.avatarCid) : null,
          });
        });
      });
      // Deliberately no early return: the API fetch below refreshes the cached
      // avatar_cid for our own address too, so a picture set on another client
      // shows up here without needing one set locally first.
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
        // Gate on the profile existing, not on `display_name`. Gating on the name
        // meant a profile carrying only an avatar was discarded outright — never
        // rendered, never cached — and since `apiFetched` is never cleared, that
        // address was then skipped for the rest of the session.
        if (!user) return;
        const name = user.display_name ?? null;
        const avatarCid = user.avatar_cid ?? null;
        if (!name && !avatarCid) return; // nothing to show; leave any cache intact
        setCached((prev) => ({
          // Keep our own context name rather than letting an empty server profile
          // blank it out.
          displayName: name ?? prev.displayName,
          avatarUri: avatarCid ? client.getMediaUrl(avatarCid) : prev.avatarUri,
        }));
        setCachedUser(address, { displayName: name, avatarCid });
      }).catch(() => {
        // Allow a retry later in the session rather than marking this address
        // permanently fetched on a transient failure.
        apiFetched.delete(address);
      });
    }
  }, [address, myAddress, myName, client]);

  // Fast path: own address
  if (address === myAddress && myName) {
    return { displayName: myName, avatarUri: cached.avatarUri };
  }

  return cached;
}
