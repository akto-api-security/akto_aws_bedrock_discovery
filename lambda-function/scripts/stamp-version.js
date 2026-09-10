/**
 * Writes the VERSION file that gets baked into the deployment zip.
 *
 * Run automatically by `npm run package` (npm invokes the "pre<script>" hook), so a build
 * can never be produced without one.
 *
 * There is deliberately NO fallback. This used to default to package.json's version, which
 * is never bumped — so forgetting the environment variable silently stamped v1.0.0 into a
 * zip uploaded to a folder named something else, and the mislabelled build then reported
 * the wrong version on every message it sent. A build is a release artifact; guessing its
 * name is worse than refusing to build.
 */
const fs = require('fs');
const path = require('path');

const version = (process.env.VERSION || '').trim();

if (!version) {
    console.error(`
  ✗ VERSION is not set, so this build has no name.

    Set it to the S3 folder you intend to publish into, so the version reported by the
    running code matches the folder it was fetched from:

        VERSION=v1.2 npm run package

    then upload to the matching folder:

        aws s3 cp ../akto-bedrock-processor.zip \\
          s3://lambda-code-akto-<region>/unified_bedrock/v1.2/akto-bedrock-processor.zip
`);
    process.exit(1);
}

// Editing the VERSION file by hand does not work — this overwrites it on every build,
// which is the point: the stamp always comes from the command that produced the artifact.
fs.writeFileSync(path.join(__dirname, '..', 'VERSION'), version + '\n');
console.log(`  stamped VERSION = ${version}`);
