# versions.json — publishing and rollback

`versions.json` sits in this product's folder inside each regional code bucket:

    s3://lambda-code-akto-<region>/aws-quick/versions.json

The `aws-quick/` prefix keeps it apart from the other products AKTO publishes into the
same bucket. Without it the file would sit at the root, contended between products, and a
Quick processor could install a version string meant for something else.

It maps an update channel to the build every account on that channel should run. The
updater Lambda in each client account reads one entry — the one named by its
`UpdateChannel` stack parameter — and installs that build if the account is not already
on it.

Accounts deployed with `UpdateChannel` blank ignore this file entirely; they have no
updater at all and stay on the version they were deployed with.

## Publishing a build

    cd lambda-function
    VERSION=v2.5 npm run package                 # stamps VERSION into the zip

    aws s3 cp ../akto-quick-processor.zip \
      s3://lambda-code-akto-us-east-1/aws-quick/v2.5/akto-quick-processor.zip

The version folder is now permanent and is never overwritten.

## Releasing it

Move `canary` first. Only accounts on the canary channel — your own test account, not
client accounts — pick it up:

    { "stable": "v2.4", "canary": "v2.5" }

Watch it for a day. The build each account is running is visible in its manifest
(`codeVersion`) in the central markers bucket, and in its startup log line.

When you are satisfied, promote:

    { "stable": "v2.5", "canary": "v2.5" }

Every client account on the stable channel installs it within the hour.

## Rolling back

Point the channel at the previous build:

    { "stable": "v2.4", "canary": "v2.5" }

There is no separate rollback path — the updater compares what is running against what
this file names and corrects the difference in either direction. Accounts return to
v2.4 on their next hourly check.

Never delete a published version folder. Rolling back reinstalls from it, so removing
it also removes your way out.

## Uploading this file

    aws s3 cp versions.json s3://lambda-code-akto-us-east-1/aws-quick/versions.json

One copy per region you deploy into, since each region has its own code bucket.

Until this file exists the updater logs "Cannot read aws-quick/versions.json - leaving code
unchanged" and does nothing. That is safe: nothing updates, and nothing breaks.
