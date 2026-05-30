#include <CoreFoundation/CoreFoundation.h>
#include <Security/AuthorizationPlugin.h>
#include <Security/SecCode.h>
#include <Security/SecRequirement.h>
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#define PI_GUI_LOCKED_USE_SOCKET_PATH "/tmp/com.pi-gui.desktop.computer-use/LockScreenLoginAuthorization.sock"
#define PI_GUI_LOCKED_USE_TOKEN_PATH "/tmp/com.pi-gui.desktop.computer-use/active-turn-token"
#define PI_GUI_LOCKED_USE_EXPECTED_IDENTIFIER "com.pi-gui.desktop.computer-use-helper"
#define PI_GUI_LOCKED_USE_EXPECTED_TEAM_IDENTIFIER "P2MBURJVUW"
#define PI_GUI_LOCKED_USE_CONFIGURATION_PATH "/Library/Application Support/PiGuiComputerUseAuthorizationPlugin/configuration.plist"
#define PI_GUI_LOCKED_USE_SOCKET_TIMEOUT_SECONDS 2

typedef struct {
    const AuthorizationCallbacks *callbacks;
    AuthorizationPluginInterface interface;
} PiGuiPlugin;

typedef struct {
    PiGuiPlugin *plugin;
    AuthorizationEngineRef engine;
} PiGuiMechanism;

static OSStatus pluginDestroy(AuthorizationPluginRef pluginRef);
static OSStatus mechanismCreate(
    AuthorizationPluginRef pluginRef,
    AuthorizationEngineRef engine,
    AuthorizationMechanismId mechanismId,
    AuthorizationMechanismRef *outMechanism
);
static OSStatus mechanismInvoke(AuthorizationMechanismRef mechanismRef);
static OSStatus mechanismDeactivate(AuthorizationMechanismRef mechanismRef);
static OSStatus mechanismDestroy(AuthorizationMechanismRef mechanismRef);
static bool requestLoginAuthorization(void);
static bool configureSocketTimeouts(int fd);
static bool socketPeerHasExpectedIdentity(int fd);
static bool codeSatisfiesExpectedRequirement(SecCodeRef code);
static bool stringEqualsCFString(CFStringRef lhs, CFStringRef rhs);
static CFStringRef copyConfiguredHelperPath(void);
static CFStringRef copyCodePath(SecCodeRef code);
static bool readActiveTurnToken(char *buffer, size_t bufferLength);
static bool readAllowResponse(int fd);

OSStatus AuthorizationPluginCreate(
    const AuthorizationCallbacks *callbacks,
    AuthorizationPluginRef *outPlugin,
    const AuthorizationPluginInterface **outPluginInterface
) {
    if (callbacks == NULL || outPlugin == NULL || outPluginInterface == NULL) {
        return errAuthorizationInternal;
    }

    PiGuiPlugin *plugin = calloc(1, sizeof(PiGuiPlugin));
    if (plugin == NULL) {
        return errAuthorizationInternal;
    }

    plugin->callbacks = callbacks;
    plugin->interface.version = kAuthorizationPluginInterfaceVersion;
    plugin->interface.PluginDestroy = pluginDestroy;
    plugin->interface.MechanismCreate = mechanismCreate;
    plugin->interface.MechanismInvoke = mechanismInvoke;
    plugin->interface.MechanismDeactivate = mechanismDeactivate;
    plugin->interface.MechanismDestroy = mechanismDestroy;

    *outPlugin = plugin;
    *outPluginInterface = &plugin->interface;
    return errAuthorizationSuccess;
}

static OSStatus pluginDestroy(AuthorizationPluginRef pluginRef) {
    free(pluginRef);
    return errAuthorizationSuccess;
}

static OSStatus mechanismCreate(
    AuthorizationPluginRef pluginRef,
    AuthorizationEngineRef engine,
    AuthorizationMechanismId mechanismId,
    AuthorizationMechanismRef *outMechanism
) {
    if (pluginRef == NULL || engine == NULL || mechanismId == NULL || outMechanism == NULL) {
        return errAuthorizationInternal;
    }

    PiGuiMechanism *mechanism = calloc(1, sizeof(PiGuiMechanism));
    if (mechanism == NULL) {
        return errAuthorizationInternal;
    }

    mechanism->plugin = (PiGuiPlugin *)pluginRef;
    mechanism->engine = engine;
    *outMechanism = mechanism;
    return errAuthorizationSuccess;
}

static OSStatus mechanismInvoke(AuthorizationMechanismRef mechanismRef) {
    if (mechanismRef == NULL) {
        return errAuthorizationInternal;
    }

    PiGuiMechanism *mechanism = (PiGuiMechanism *)mechanismRef;
    AuthorizationResult result = requestLoginAuthorization() ? kAuthorizationResultAllow : kAuthorizationResultDeny;
    return mechanism->plugin->callbacks->SetResult(mechanism->engine, result);
}

static OSStatus mechanismDeactivate(AuthorizationMechanismRef mechanismRef) {
    if (mechanismRef == NULL) {
        return errAuthorizationInternal;
    }

    PiGuiMechanism *mechanism = (PiGuiMechanism *)mechanismRef;
    return mechanism->plugin->callbacks->DidDeactivate(mechanism->engine);
}

static OSStatus mechanismDestroy(AuthorizationMechanismRef mechanismRef) {
    free(mechanismRef);
    return errAuthorizationSuccess;
}

static bool requestLoginAuthorization(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        return false;
    }

    if (!configureSocketTimeouts(fd)) {
        close(fd);
        return false;
    }

    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    strlcpy(address.sun_path, PI_GUI_LOCKED_USE_SOCKET_PATH, sizeof(address.sun_path));

    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        close(fd);
        return false;
    }

    if (!socketPeerHasExpectedIdentity(fd)) {
        close(fd);
        return false;
    }

    char token[96];
    if (!readActiveTurnToken(token, sizeof(token))) {
        close(fd);
        return false;
    }

    char request[128];
    int requestLength = snprintf(request, sizeof(request), "authorize %s\n", token);
    if (requestLength <= 0 || requestLength >= (int)sizeof(request)) {
        close(fd);
        return false;
    }
    ssize_t written = write(fd, request, (size_t)requestLength);
    if (written != (ssize_t)requestLength) {
        close(fd);
        return false;
    }

    bool allowed = readAllowResponse(fd);
    close(fd);
    return allowed;
}

static bool configureSocketTimeouts(int fd) {
    struct timeval timeout;
    timeout.tv_sec = PI_GUI_LOCKED_USE_SOCKET_TIMEOUT_SECONDS;
    timeout.tv_usec = 0;

    return setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0
        && setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) == 0;
}

static bool socketPeerHasExpectedIdentity(int fd) {
    audit_token_t token;
    socklen_t tokenLength = sizeof(token);
    if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenLength) != 0 || tokenLength != sizeof(token)) {
        return false;
    }

    CFDataRef auditTokenValue = CFDataCreate(kCFAllocatorDefault, (const UInt8 *)&token, sizeof(token));
    if (auditTokenValue == NULL) {
        return false;
    }

    const void *keys[] = { kSecGuestAttributeAudit };
    const void *values[] = { auditTokenValue };
    CFDictionaryRef attributes = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    CFRelease(auditTokenValue);
    if (attributes == NULL) {
        return false;
    }

    SecCodeRef code = NULL;
    OSStatus codeStatus = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code);
    CFRelease(attributes);
    if (codeStatus != noErr || code == NULL) {
        return false;
    }

    if (!codeSatisfiesExpectedRequirement(code)) {
        CFRelease(code);
        return false;
    }

    CFStringRef expectedPath = copyConfiguredHelperPath();
    CFStringRef actualPath = copyCodePath(code);
    CFRelease(code);

    bool pathMatches = expectedPath != NULL && actualPath != NULL && stringEqualsCFString(expectedPath, actualPath);
    if (expectedPath != NULL) {
        CFRelease(expectedPath);
    }
    if (actualPath != NULL) {
        CFRelease(actualPath);
    }
    return pathMatches;
}

static bool codeSatisfiesExpectedRequirement(SecCodeRef code) {
    SecRequirementRef requirement = NULL;
    OSStatus requirementStatus = SecRequirementCreateWithString(
        CFSTR("identifier \"" PI_GUI_LOCKED_USE_EXPECTED_IDENTIFIER "\" and anchor apple generic and certificate leaf[subject.OU] = \"" PI_GUI_LOCKED_USE_EXPECTED_TEAM_IDENTIFIER "\""),
        kSecCSDefaultFlags,
        &requirement
    );
    if (requirementStatus != noErr || requirement == NULL) {
        return false;
    }

    OSStatus validityStatus = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
    CFRelease(requirement);
    return validityStatus == noErr;
}

static bool stringEqualsCFString(CFStringRef lhs, CFStringRef rhs) {
    return CFStringCompare(lhs, rhs, 0) == kCFCompareEqualTo;
}

static CFStringRef copyConfiguredHelperPath(void) {
    CFURLRef configurationURL = CFURLCreateFromFileSystemRepresentation(
        kCFAllocatorDefault,
        (const UInt8 *)PI_GUI_LOCKED_USE_CONFIGURATION_PATH,
        strlen(PI_GUI_LOCKED_USE_CONFIGURATION_PATH),
        false
    );
    if (configurationURL == NULL) {
        return NULL;
    }

    CFReadStreamRef stream = CFReadStreamCreateWithFile(kCFAllocatorDefault, configurationURL);
    CFRelease(configurationURL);
    if (stream == NULL) {
        return NULL;
    }

    if (!CFReadStreamOpen(stream)) {
        CFRelease(stream);
        return NULL;
    }

    CFPropertyListRef propertyList = CFPropertyListCreateWithStream(
        kCFAllocatorDefault,
        stream,
        0,
        kCFPropertyListImmutable,
        NULL,
        NULL
    );
    CFReadStreamClose(stream);
    CFRelease(stream);
    if (propertyList == NULL || CFGetTypeID(propertyList) != CFDictionaryGetTypeID()) {
        if (propertyList != NULL) {
            CFRelease(propertyList);
        }
        return NULL;
    }

    CFStringRef helperPath = CFDictionaryGetValue((CFDictionaryRef)propertyList, CFSTR("helperCodePath"));
    if (helperPath == NULL) {
        helperPath = CFDictionaryGetValue((CFDictionaryRef)propertyList, CFSTR("helperExecutablePath"));
    }
    if (helperPath == NULL || CFGetTypeID(helperPath) != CFStringGetTypeID()) {
        CFRelease(propertyList);
        return NULL;
    }

    CFRetain(helperPath);
    CFRelease(propertyList);
    return helperPath;
}

static CFStringRef copyCodePath(SecCodeRef code) {
    CFURLRef codeURL = NULL;
    OSStatus pathStatus = SecCodeCopyPath((SecStaticCodeRef)code, kSecCSDefaultFlags, &codeURL);
    if (pathStatus != noErr || codeURL == NULL) {
        return NULL;
    }

    CFStringRef path = CFURLCopyFileSystemPath(codeURL, kCFURLPOSIXPathStyle);
    CFRelease(codeURL);
    return path;
}

static bool readActiveTurnToken(char *buffer, size_t bufferLength) {
    if (buffer == NULL || bufferLength < 33) {
        return false;
    }

    int fd = open(PI_GUI_LOCKED_USE_TOKEN_PATH, O_RDONLY);
    if (fd < 0) {
        return false;
    }

    ssize_t count = read(fd, buffer, bufferLength - 1);
    close(fd);
    if (count < 32) {
        return false;
    }

    buffer[count] = '\0';
    while (count > 0 && (buffer[count - 1] == '\n' || buffer[count - 1] == '\r' || buffer[count - 1] == ' ' || buffer[count - 1] == '\t')) {
        buffer[count - 1] = '\0';
        count--;
    }
    return count >= 32;
}

static bool readAllowResponse(int fd) {
    char buffer[32];
    ssize_t count = read(fd, buffer, sizeof(buffer) - 1);
    if (count <= 0) {
        return false;
    }
    buffer[count] = '\0';
    return strcmp(buffer, "ALLOW\n") == 0 || strcmp(buffer, "ALLOW") == 0;
}
