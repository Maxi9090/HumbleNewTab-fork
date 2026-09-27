### HumbleNewTab-fork does not collect, transmit, or share any data

#### Permissions
- **`bookmarks`** reads your bookmark tree to render the page.
- **`tabs`** reads `favIconUrl` from open tabs to display site icons locally, replacing the upstream third-party favicon providers.

#### Optional permissions
- **`topSites`** reads the browser's most visited sites for the "Most visited" folder.
- **`sessions`** reads recently closed tabs and windows for the "Recently closed tabs" and "Recently closed windows" folders.

#### Storage
- **`localStorage`** stores the settings, folder states, the bookmark tree cache, cache of the special folders, and favicon data URLs. Gets cleared on uninstall.
