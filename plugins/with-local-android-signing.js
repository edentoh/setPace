const fs = require('fs');
const path = require('path');

const { withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');

const GRADLE_DISTRIBUTION_URL =
  'https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip';
const LOCAL_GRADLE_PROPERTIES = {
  'kotlin.daemon.jvmargs': '-Xmx2048m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
  newArchEnabled: 'false',
  'org.gradle.daemon.performance.disable-logging': 'true',
  'org.gradle.jvmargs': '-Xmx4096m -XX:MaxMetaspaceSize=1536m -Dfile.encoding=UTF-8',
  'org.gradle.parallel': 'false',
  'org.gradle.workers.max': '2',
  reactNativeArchitectures: 'arm64-v8a',
};

const RELEASE_SIGNING_CONFIG = `        release {
            def releaseStoreFile = findProperty('SETPACE_RELEASE_STORE_FILE')
            if (releaseStoreFile) {
                storeFile file(releaseStoreFile)
                storePassword findProperty('SETPACE_RELEASE_STORE_PASSWORD')
                keyAlias findProperty('SETPACE_RELEASE_KEY_ALIAS')
                keyPassword findProperty('SETPACE_RELEASE_KEY_PASSWORD')
            }
        }`;

const DEBUG_SIGNING_CONFIG = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }`;

const DEBUG_RELEASE_SIGNING_LINE = '            signingConfig signingConfigs.debug';
const LOCAL_RELEASE_SIGNING_LINE =
  "            signingConfig findProperty('SETPACE_RELEASE_STORE_FILE') ? signingConfigs.release : signingConfigs.debug";

function patchAppBuildGradle(contents) {
  let nextContents = contents;

  if (!nextContents.includes("findProperty('SETPACE_RELEASE_STORE_FILE')")) {
    nextContents = nextContents.replace(
      DEBUG_SIGNING_CONFIG,
      `${DEBUG_SIGNING_CONFIG}\n${RELEASE_SIGNING_CONFIG}`
    );
  }

  const buildTypesStart = nextContents.indexOf('    buildTypes {');
  const releaseBlockStart =
    buildTypesStart === -1 ? -1 : nextContents.indexOf('        release {', buildTypesStart);
  if (releaseBlockStart === -1) {
    return nextContents;
  }

  const releaseBlockEnd = nextContents.indexOf('        }', releaseBlockStart);
  const beforeReleaseBlock = nextContents.slice(0, releaseBlockStart);
  const releaseBlock = nextContents.slice(releaseBlockStart, releaseBlockEnd);
  const afterReleaseBlock = nextContents.slice(releaseBlockEnd);

  if (
    !releaseBlock.includes("findProperty('SETPACE_RELEASE_STORE_FILE')") &&
    releaseBlock.includes(DEBUG_RELEASE_SIGNING_LINE)
  ) {
    return `${beforeReleaseBlock}${releaseBlock.replace(
      DEBUG_RELEASE_SIGNING_LINE,
      LOCAL_RELEASE_SIGNING_LINE
    )}${afterReleaseBlock}`;
  }

  return nextContents;
}

function patchGradleProperties(contents) {
  const lines = contents.split(/\r?\n/);

  for (const [key, value] of Object.entries(LOCAL_GRADLE_PROPERTIES)) {
    const propertyLine = `${key}=${value}`;
    const existingIndex = lines.findIndex((line) => line.startsWith(`${key}=`));

    if (existingIndex === -1) {
      lines.push(propertyLine);
    } else {
      lines[existingIndex] = propertyLine;
    }
  }

  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

module.exports = function withLocalAndroidSigning(config) {
  config = withAppBuildGradle(config, (config) => {
    if (config.modResults.language === 'groovy') {
      config.modResults.contents = patchAppBuildGradle(config.modResults.contents);
    }

    return config;
  });

  return withDangerousMod(config, [
    'android',
    (config) => {
      const wrapperPropertiesPath = path.join(
        config.modRequest.platformProjectRoot,
        'gradle',
        'wrapper',
        'gradle-wrapper.properties'
      );

      if (fs.existsSync(wrapperPropertiesPath)) {
        const contents = fs.readFileSync(wrapperPropertiesPath, 'utf8');
        const nextContents = contents.replace(
          /^distributionUrl=.*$/m,
          `distributionUrl=${GRADLE_DISTRIBUTION_URL}`
        );

        fs.writeFileSync(wrapperPropertiesPath, nextContents);
      }

      const gradlePropertiesPath = path.join(
        config.modRequest.platformProjectRoot,
        'gradle.properties'
      );

      if (fs.existsSync(gradlePropertiesPath)) {
        const contents = fs.readFileSync(gradlePropertiesPath, 'utf8');
        fs.writeFileSync(gradlePropertiesPath, patchGradleProperties(contents));
      }

      return config;
    },
  ]);
};
