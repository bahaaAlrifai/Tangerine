#!/bin/bash

GROUP="$1"
CONTENT_PATH="$2"
RELEASE_TYPE="$3"
RELEASE_DIRECTORY="/tangerine/client/releases/$RELEASE_TYPE/pwas/$GROUP"
BUILD_ID="$4"
UUID="$4"
VERSION_TAG="$5"
ARCHIVE_DIRECTORY="/tangerine/client/releases/$RELEASE_TYPE/pwas/archive/$GROUP/$BUILD_ID-$VERSION_TAG"

echo "RELEASE_DIRECTORY: $RELEASE_DIRECTORY"

if [ "$2" = "--help" ] || [ "$GROUP" = "" ] || [ "$CONTENT_PATH" = "" ] || [ "$RELEASE_TYPE" = "" ]; then
  echo ""
  echo "RELEASE PWA"
  echo "A command for releasing a PWA using a secret URL."
  echo ""
  echo "./release-pwa.sh <secret> <content path> <release type>"
  echo ""
  echo "Release type is either qa or prod."
  echo ""
  echo "Usage:"
  echo "  release-pwa a4uw93 ./content/groups/group-a prod"
  echo ""
  echo "Then visit https://foo.tangerinecentral.org/pwa/a4uw93/"
  echo ""
  echo ""
  exit
fi

cd /tangerine/client

if [ -z "$T_ORIENTATION" ]
then
    echo "releasing in the default orientation."
    sed -i -e "s#T_ORIENTATION#portrait" builds/pwa/manifest.json
else
    echo "releasing in the configured orientation: $T_ORIENTATION."
    # modify the orientation per configuration settings
    sed -i -e "s#T_ORIENTATION#"$T_ORIENTATION"#g" builds/pwa/manifest.json
fi

# Create a temporary PWA folder that we'll move to the secret.
cp -r builds/pwa pwa-tools/service-worker-generator/.pwa-temporary
cd pwa-tools/service-worker-generator

# Generate release UUID and name the service worker after it.
# UUID=$(./node_modules/.bin/uuid)
mv .pwa-temporary/release-uuid .pwa-temporary/$UUID

# Install content into PWA.
rm -r .pwa-temporary/$UUID/app/assets
cp -r $CONTENT_PATH .pwa-temporary/$UUID/app/assets

echo "RELEASE PWA: removing client-uploads dir"
rm -rf .pwa-temporary/$UUID/app/assets/client-uploads

echo $BUILD_ID > .pwa-temporary/$UUID/app/assets/tangerine-build-id
echo $RELEASE_TYPE > .pwa-temporary/$UUID/app/assets/tangerine-build-channel
echo $VERSION_TAG > .pwa-temporary/$UUID/app/assets/tangerine-version-tag 
echo $T_VERSION > .pwa-temporary/$UUID/app/assets/tangerine-version

# Add logo.
cp .pwa-temporary/logo.svg .pwa-temporary/$UUID/

# Generate service worker.
./node_modules/.bin/workbox generate:sw

mv .pwa-temporary/sw.js .pwa-temporary/$UUID.js
echo $UUID > .pwa-temporary/release-uuid.txt

rm -r $RELEASE_DIRECTORY
if [ $T_ARCHIVE_PWAS_TO_DISK == true ]; then 
  mkdir -p $ARCHIVE_DIRECTORY
  cp -r .pwa-temporary $ARCHIVE_DIRECTORY
fi
mv .pwa-temporary $RELEASE_DIRECTORY


echo "Release with UUID of $UUID to $RELEASE_DIRECTORY with Build ID of $BUILD_ID, channel of $RELEASE_TYPE, versionTag of $VERSION_TAG"