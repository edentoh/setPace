# SetPace

SetPace is an Expo React Native interval-start timer app for Android APK distribution.

## Local Android APK build

Use this flow when you want to build APKs on your own computer instead of using EAS Build. This does not use Expo Go and does not publish to the Play Store.

### Required Software

- Android Studio
- Android SDK installed through Android Studio
- OpenJDK / Java compatible with the Android Gradle plugin
- Node.js and npm

Make sure Android Studio can open an Android project and that your Java/Android SDK environment is available in the terminal.

On Windows, Android Studio includes a Java runtime. To make Gradle find it in the current PowerShell session:

```powershell
$env:JAVA_HOME = "$env:ProgramFiles\Android\Android Studio\jbr"
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
java -version
```

On Windows, Android Studio normally installs the SDK under:

```powershell
$env:LOCALAPPDATA\Android\Sdk
```

If Gradle cannot find Android SDK, set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to your SDK path.

If Gradle fails with `SDK location not found`, Android Studio is installed but the Android SDK path is missing. Open Android Studio, go to **More Actions > SDK Manager**, and install:

- Android SDK Platform
- Android SDK Build-Tools
- Android SDK Platform-Tools
- Android SDK Command-line Tools

After installing, the SDK path is usually:

```text
C:\Users\<you>\AppData\Local\Android\Sdk
```

Create `android/local.properties` with your real SDK path:

```properties
sdk.dir=C\:\\Users\\ETBZ\\AppData\\Local\\Android\\Sdk
```

`android/local.properties` is machine-local and must not be committed.

### Install JavaScript Dependencies

```powershell
npm install
```

### Generate The Android Project

Generate the native Android project with Expo prebuild:

```powershell
npx expo prebuild --platform android
```

This creates the `android/` folder. If `android/` already exists, inspect current native changes before regenerating or cleaning it.

### Release Signing For Internal APK Testing

The generated Gradle config supports local release signing through Gradle properties:

- `SETPACE_RELEASE_STORE_FILE`
- `SETPACE_RELEASE_STORE_PASSWORD`
- `SETPACE_RELEASE_KEY_ALIAS`
- `SETPACE_RELEASE_KEY_PASSWORD`

Create a local keystore. From the project root on Windows:

```powershell
keytool -genkeypair -v -storetype JKS -keystore android/app/setpace-release.jks -alias setpace-release -keyalg RSA -keysize 2048 -validity 10000
```

If PowerShell says `keytool` is not recognized, use the Java bundled with Android Studio:

```powershell
& "$env:ProgramFiles\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v -storetype JKS -keystore android/app/setpace-release.jks -alias setpace-release -keyalg RSA -keysize 2048 -validity 10000
```

If that path does not exist, install Android Studio or a JDK, then open a new terminal so the Java tools are available.

Then add these properties to `android/gradle.properties` or your user-level `~/.gradle/gradle.properties`:

```properties
SETPACE_RELEASE_STORE_FILE=setpace-release.jks
SETPACE_RELEASE_STORE_PASSWORD=your_store_password
SETPACE_RELEASE_KEY_ALIAS=setpace-release
SETPACE_RELEASE_KEY_PASSWORD=your_key_password
```

Do not commit keystore files or real passwords. Keystore patterns are listed in `.gitignore`.

If these properties are missing, Gradle falls back to the generated debug keystore. That APK is installable for quick local checks, but use your local release keystore for internal distribution.

### Build Release APK

Windows:

```powershell
cd android
.\gradlew.bat assembleRelease
```

macOS/Linux:

```bash
cd android
./gradlew assembleRelease
```

If the build fails with `JvmVendorSpec IBM_SEMERU`, check that `android/gradle/wrapper/gradle-wrapper.properties` uses Gradle `8.14.3`. Gradle 9.x can be incompatible with the generated Android Gradle Plugin/React Native Gradle plugin versions.

If the build fails with `Metaspace`, the local Gradle settings should use:

```properties
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1536m -Dfile.encoding=UTF-8
kotlin.daemon.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8
org.gradle.workers.max=2
org.gradle.parallel=false
reactNativeArchitectures=arm64-v8a
newArchEnabled=false
```

This project pins those values during prebuild. `arm64-v8a` targets modern Android phones and skips emulator/x86 native builds to reduce memory use. If you need a universal APK for old 32-bit phones or emulators, change `reactNativeArchitectures` in `android/gradle.properties` and expect longer builds.

### APK Output Location

The release APK is written to:

```text
android/app/build/outputs/apk/release/
```

The file is usually named:

```text
app-release.apk
```

### Install APK On Android Phone

Copy the APK to your phone and open it from the file manager, or install with ADB:

```powershell
adb install android/app/build/outputs/apk/release/app-release.apk
```

If you already have SetPace installed with a different signing key, uninstall the old app first or Android will reject the update.

### Faster Development Without Full APK Rebuilds

For JavaScript and TypeScript changes, use a development build so you do not need a release APK for every edit:

```powershell
npx expo start --dev-client
```

Build a local release APK again when you need to test the standalone installed app.
