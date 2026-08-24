#define _DARWIN_C_SOURCE

#include <errno.h>
#include <fido.h>
#include <limits.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <readpassphrase.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum {
	DEFAULT_ATTEMPTS = 3,
	DEFAULT_TIMEOUT_MS = 180000,
	MAX_ATTEMPTS = 5,
	MAX_CREDENTIALS = 16,
	MAX_PIN_ENTRIES = 3,
	MAX_TIMEOUT_MS = 300000,
	TOUCH_WINDOW_MS = 60000,
	TOUCH_POLL_MS = 100,
};

struct blob {
	unsigned char *ptr;
	size_t len;
};

static void
free_blob(struct blob *blob)
{
	if (blob->ptr != NULL) {
		OPENSSL_cleanse(blob->ptr, blob->len);
		free(blob->ptr);
	}
	blob->ptr = NULL;
	blob->len = 0;
}

static bool
parse_bounded_int(const char *value, int minimum, int maximum, int *result)
{
	char *end = NULL;
	long parsed;

	errno = 0;
	parsed = strtol(value, &end, 10);
	if (errno != 0 || value[0] == '\0' || end == NULL || end[0] != '\0' ||
	    parsed < minimum || parsed > maximum)
		return false;
	*result = (int)parsed;
	return true;
}

static char *
read_line(const char *label)
{
	char *line = NULL;
	size_t capacity = 0;
	ssize_t length;

	if ((length = getline(&line, &capacity, stdin)) < 0) {
		fprintf(stderr, "missing %s\n", label);
		free(line);
		return NULL;
	}
	while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r'))
		line[--length] = '\0';
	if (length == 0) {
		fprintf(stderr, "empty %s\n", label);
		free(line);
		return NULL;
	}
	return line;
}

static bool
decode_base64(const char *encoded, struct blob *decoded)
{
	size_t encoded_len = strlen(encoded);
	size_t padding = 0;
	size_t capacity;
	int length;

	if (encoded_len == 0 || encoded_len % 4 != 0 || encoded_len > INT_MAX)
		return false;
	for (size_t i = 0; i < encoded_len; i++) {
		unsigned char c = (unsigned char)encoded[i];
		if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
		    (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '='))
			return false;
		if (c == '=' && i < encoded_len - 2)
			return false;
	}
	if (encoded[encoded_len - 1] == '=')
		padding++;
	if (encoded_len > 1 && encoded[encoded_len - 2] == '=')
		padding++;
	capacity = (encoded_len / 4) * 3;
	if ((decoded->ptr = calloc(capacity + 1, 1)) == NULL)
		return false;
	length = EVP_DecodeBlock(decoded->ptr,
	    (const unsigned char *)encoded, (int)encoded_len);
	if (length < 0 || (size_t)length < padding) {
		free_blob(decoded);
		return false;
	}
	decoded->len = (size_t)length - padding;
	return true;
}

static bool
print_base64(const unsigned char *data, size_t data_len)
{
	size_t encoded_len;
	unsigned char *encoded;
	int result;

	if (data == NULL || data_len == 0 || data_len > INT_MAX)
		return false;
	if (data_len > (SIZE_MAX - 2) / 4 * 3)
		return false;
	encoded_len = 4 * ((data_len + 2) / 3);
	if ((encoded = calloc(encoded_len + 1, 1)) == NULL)
		return false;
	result = EVP_EncodeBlock(encoded, data, (int)data_len);
	if (result < 0 || (size_t)result != encoded_len) {
		free(encoded);
		return false;
	}
	printf("%s\n", encoded);
	free(encoded);
	return true;
}

static int64_t
monotonic_ms(void)
{
	struct timespec value;

	if (clock_gettime(CLOCK_MONOTONIC, &value) != 0)
		return -1;
	return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static bool
retryable_touch_error(int error)
{
	return error == FIDO_ERR_TIMEOUT ||
	    error == FIDO_ERR_OPERATION_DENIED ||
	    error == FIDO_ERR_KEEPALIVE_CANCEL ||
	    error == FIDO_ERR_USER_ACTION_TIMEOUT ||
	    error == FIDO_ERR_ACTION_TIMEOUT ||
	    error == FIDO_ERR_USER_PRESENCE_REQUIRED;
}

static int
configure_assertion(fido_assert_t *assertion, const struct blob *client_hash,
    const char *rp_id, const struct blob *credential_ids,
    size_t credential_count, bool use_uv)
{
	int error;

	if ((error = fido_assert_set_clientdata_hash(assertion,
	    client_hash->ptr, client_hash->len)) != FIDO_OK ||
	    (error = fido_assert_set_rp(assertion, rp_id)) != FIDO_OK)
		return error;
	for (size_t i = 0; i < credential_count; i++) {
		if ((error = fido_assert_allow_cred(assertion,
		    credential_ids[i].ptr, credential_ids[i].len)) != FIDO_OK)
			return error;
	}
	if ((error = fido_assert_set_up(assertion, FIDO_OPT_TRUE)) != FIDO_OK ||
	    (error = fido_assert_set_uv(assertion,
	    use_uv ? FIDO_OPT_TRUE : FIDO_OPT_FALSE)) != FIDO_OK)
		return error;
	return FIDO_OK;
}

static int
run_attempt(const char *device_path, const struct blob *client_hash,
    const char *rp_id, const struct blob *credential_ids,
    size_t credential_count, const char *pin, bool use_uv, int timeout_ms,
    fido_assert_t **result)
{
	fido_assert_t *assertion = NULL;
	fido_dev_t *device = NULL;
	int error = FIDO_ERR_INTERNAL;

	if ((assertion = fido_assert_new()) == NULL ||
	    (device = fido_dev_new()) == NULL) {
		fprintf(stderr, "cannot allocate libfido2 request\n");
		goto out;
	}
	if ((error = configure_assertion(assertion, client_hash, rp_id,
	    credential_ids, credential_count, use_uv)) != FIDO_OK) {
		fprintf(stderr, "cannot configure assertion: %s\n", fido_strerr(error));
		goto out;
	}
	if ((error = fido_dev_open(device, device_path)) != FIDO_OK) {
		fprintf(stderr, "cannot open authenticator: %s\n", fido_strerr(error));
		goto out;
	}
	if ((error = fido_dev_set_timeout(device, timeout_ms)) != FIDO_OK) {
		fprintf(stderr, "cannot set authenticator timeout: %s\n", fido_strerr(error));
		goto out;
	}
	error = fido_dev_get_assert(device, assertion, pin);
	(void)fido_dev_cancel(device);
	(void)fido_dev_close(device);
	if (error == FIDO_OK) {
		if (fido_assert_count(assertion) != 1) {
			fprintf(stderr, "authenticator returned an unexpected assertion count\n");
			error = FIDO_ERR_INTERNAL;
		} else {
			*result = assertion;
			assertion = NULL;
		}
	}

out:
	if (device != NULL)
		(void)fido_dev_close(device);
	fido_dev_free(&device);
	fido_assert_free(&assertion);
	return error;
}

static bool
pin_retries_remaining(const char *device_path, int *retries)
{
	fido_dev_t *device = NULL;
	int error;
	bool available = false;

	if ((device = fido_dev_new()) == NULL)
		return false;
	if ((error = fido_dev_open(device, device_path)) == FIDO_OK &&
	    (error = fido_dev_set_timeout(device, 5000)) == FIDO_OK &&
	    (error = fido_dev_get_retry_count(device, retries)) == FIDO_OK)
		available = true;
	else
		fprintf(stderr, "cannot read remaining PIN retries: %s\n",
		    fido_strerr(error));
	(void)fido_dev_close(device);
	fido_dev_free(&device);
	return available;
}

static bool
read_pin(char *pin, size_t pin_size, bool retry)
{
	const char *prompt = retry
	    ? "YubiKey PIN retry (still local; not stored): "
	    : "YubiKey PIN (entered once unless the key permits a retry): ";

	OPENSSL_cleanse(pin, pin_size);
	if (readpassphrase(prompt, pin, pin_size, RPP_REQUIRE_TTY) == NULL ||
	    pin[0] == '\0') {
		fprintf(stderr, "could not read a non-empty PIN from the local terminal\n");
		return false;
	}
	return true;
}

static bool
print_assertion(const struct blob *client_hash, const char *rp_id,
    const fido_assert_t *assertion)
{
	const unsigned char *authdata = fido_assert_authdata_raw_ptr(assertion, 0);
	size_t authdata_len = fido_assert_authdata_raw_len(assertion, 0);
	const unsigned char *credential_id = fido_assert_id_ptr(assertion, 0);
	size_t credential_id_len = fido_assert_id_len(assertion, 0);
	const unsigned char *signature = fido_assert_sig_ptr(assertion, 0);
	size_t signature_len = fido_assert_sig_len(assertion, 0);

	if (!print_base64(client_hash->ptr, client_hash->len))
		return false;
	printf("%s\n", rp_id);
	if (!print_base64(credential_id, credential_id_len) ||
	    !print_base64(authdata, authdata_len) ||
	    !print_base64(signature, signature_len))
		return false;
	return fflush(stdout) == 0;
}

static int
self_test(void)
{
	static const char expected[] = "remote-fido";
	struct blob decoded = {0};

	if (!decode_base64("cmVtb3RlLWZpZG8=", &decoded) ||
	    decoded.len != sizeof(expected) - 1 ||
	    memcmp(decoded.ptr, expected, decoded.len) != 0) {
		free_blob(&decoded);
		return 1;
	}
	free_blob(&decoded);
	puts("remote-fido-assert self-test passed");
	return 0;
}

static int
touch_test(const char *device_path, bool force_u2f)
{
	struct timespec pause = {.tv_sec = 0, .tv_nsec = TOUCH_POLL_MS * 1000000L};
	fido_dev_t *device = NULL;
	int64_t started_ms;
	int touched = 0;
	int error;
	int result = 1;

	fido_init(getenv("REMOTE_FIDO_DEBUG") != NULL ? FIDO_DEBUG : 0);
	if ((device = fido_dev_new()) == NULL) {
		fprintf(stderr, "cannot allocate touch probe\n");
		goto out;
	}
	if ((error = fido_dev_open(device, device_path)) != FIDO_OK) {
		fprintf(stderr, "cannot open authenticator: %s\n", fido_strerr(error));
		goto out;
	}
	if (force_u2f)
		fido_dev_force_u2f(device);
	if ((error = fido_dev_get_touch_begin(device)) != FIDO_OK) {
		fprintf(stderr, "cannot start touch probe: %s\n", fido_strerr(error));
		goto out;
	}
	if ((started_ms = monotonic_ms()) < 0) {
		fprintf(stderr, "cannot read monotonic clock\n");
		goto out;
	}
	fprintf(stderr,
	    "\n\a\033[1;33mTOUCH YUBIKEY NOW\033[0m — %s sensor-only test, 30 seconds; "
	    "no account or credential is involved.\n",
	    force_u2f ? "U2F" : "CTAP2");
	fflush(stderr);
	while (monotonic_ms() - started_ms < 30000) {
		if ((error = fido_dev_get_touch_status(device, &touched,
		    TOUCH_POLL_MS)) != FIDO_OK) {
			fprintf(stderr, "touch probe failed: %s\n", fido_strerr(error));
			goto out;
		}
		if (touched) {
			fprintf(stderr, "TOUCH RECORDED by libfido2.\n");
			result = 0;
			goto out;
		}
		(void)nanosleep(&pause, NULL);
	}
	fprintf(stderr, "NO TOUCH RECORDED within 30 seconds.\n");

out:
	if (device != NULL) {
		(void)fido_dev_cancel(device);
		(void)fido_dev_close(device);
	}
	fido_dev_free(&device);
	return result;
}

static void
usage(const char *program)
{
	fprintf(stderr,
	    "usage: %s [--timeout-ms N] [--attempts N] "
	    "[--uv required|preferred|discouraged] DEVICE\n",
	    program);
}

int
main(int argc, char **argv)
{
	char *client_hash_b64 = NULL;
	char *credential_count_text = NULL;
	char *rp_id = NULL;
	char pin[256] = {0};
	struct blob client_hash = {0};
	struct blob credential_ids[MAX_CREDENTIALS] = {0};
	fido_assert_t *assertion = NULL;
	const char *device_path = NULL;
	const char *uv = "preferred";
	int attempts = DEFAULT_ATTEMPTS;
	int credential_count = 0;
	int pin_entries = 0;
	int timeout_ms = DEFAULT_TIMEOUT_MS;
	int64_t started_ms;
	int exit_code = 1;
	bool use_uv;

	if (argc == 2 && strcmp(argv[1], "--self-test") == 0)
		return self_test();
	if (argc == 3 && strcmp(argv[1], "--touch-test") == 0)
		return touch_test(argv[2], false);
	if (argc == 3 && strcmp(argv[1], "--touch-test-u2f") == 0)
		return touch_test(argv[2], true);
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) {
			if (!parse_bounded_int(argv[++i], 30000, MAX_TIMEOUT_MS, &timeout_ms)) {
				usage(argv[0]);
				goto out;
			}
		} else if (strcmp(argv[i], "--attempts") == 0 && i + 1 < argc) {
			if (!parse_bounded_int(argv[++i], 1, MAX_ATTEMPTS, &attempts)) {
				usage(argv[0]);
				goto out;
			}
		} else if (strcmp(argv[i], "--uv") == 0 && i + 1 < argc) {
			uv = argv[++i];
			if (strcmp(uv, "required") != 0 && strcmp(uv, "preferred") != 0 &&
			    strcmp(uv, "discouraged") != 0) {
				usage(argv[0]);
				goto out;
			}
		} else if (argv[i][0] != '-' && device_path == NULL) {
			device_path = argv[i];
		} else {
			usage(argv[0]);
			goto out;
		}
	}
	if (device_path == NULL) {
		usage(argv[0]);
		goto out;
	}
	if ((client_hash_b64 = read_line("client-data hash")) == NULL ||
	    (rp_id = read_line("relying-party ID")) == NULL ||
	    (credential_count_text = read_line("credential count")) == NULL ||
	    !parse_bounded_int(credential_count_text, 1, MAX_CREDENTIALS,
	    &credential_count))
		goto out;
	for (int i = 0; i < credential_count; i++) {
		char *encoded = read_line("credential ID");

		if (encoded == NULL || !decode_base64(encoded, &credential_ids[i]) ||
		    credential_ids[i].len == 0 || credential_ids[i].len > 1024) {
			free(encoded);
			fprintf(stderr, "invalid credential ID\n");
			goto out;
		}
		free(encoded);
	}
	if (strlen(rp_id) > 253 ||
	    !decode_base64(client_hash_b64, &client_hash) || client_hash.len != 32) {
		fprintf(stderr, "invalid assertion input\n");
		goto out;
	}

	fido_init(getenv("REMOTE_FIDO_DEBUG") != NULL ? FIDO_DEBUG : 0);
	if ((started_ms = monotonic_ms()) < 0) {
		fprintf(stderr, "cannot read monotonic clock\n");
		goto out;
	}
	use_uv = strcmp(uv, "discouraged") != 0;
	if (use_uv) {
		if (!read_pin(pin, sizeof(pin), false))
			goto out;
		pin_entries++;
	}
	for (int attempt = 1; attempt <= attempts; attempt++) {
		int64_t elapsed = monotonic_ms() - started_ms;
		int remaining_ms = timeout_ms - (int)elapsed;
		int attempt_timeout;
		int error;

		if (remaining_ms <= 1000) {
			fprintf(stderr, "browser ceremony deadline expired\n");
			break;
		}
		attempt_timeout = remaining_ms < TOUCH_WINDOW_MS
		    ? remaining_ms : TOUCH_WINDOW_MS;
		fprintf(stderr,
		    "\n\a\033[1;33mTOUCH YUBIKEY NOW\033[0m — attempt %d/%d, "
		    "up to %d seconds. Repeated taps while this prompt is active "
		    "do not cancel it.\n",
		    attempt, attempts, (attempt_timeout + 999) / 1000);
		fflush(stderr);
		error = run_attempt(device_path, &client_hash, rp_id, credential_ids,
		    (size_t)credential_count, use_uv ? pin : NULL, use_uv,
		    attempt_timeout, &assertion);
		if (error == FIDO_OK) {
			fprintf(stderr, "YubiKey assertion accepted.\n");
			if (!print_assertion(&client_hash, rp_id, assertion)) {
				fprintf(stderr, "cannot write assertion response\n");
				break;
			}
			exit_code = 0;
			break;
		}
		fprintf(stderr, "touch attempt %d did not complete: %s\n",
		    attempt, fido_strerr(error));
		if (error == FIDO_ERR_PIN_INVALID && pin_entries < MAX_PIN_ENTRIES) {
			int retries = 0;

			if (pin_retries_remaining(device_path, &retries) && retries > 1) {
				fprintf(stderr,
				    "Incorrect PIN; the YubiKey reports %d retries remaining.\n",
				    retries);
				if (!read_pin(pin, sizeof(pin), true))
					break;
				pin_entries++;
				attempt--;
				continue;
			}
		}
		if (!retryable_touch_error(error)) {
			if (error == FIDO_ERR_PIN_INVALID || error == FIDO_ERR_PIN_AUTH_BLOCKED ||
			    error == FIDO_ERR_PIN_BLOCKED)
				fprintf(stderr,
				    "PIN failure cannot be retried safely in this ceremony.\n");
			else if (error == FIDO_ERR_NO_CREDENTIALS)
				fprintf(stderr, "this YubiKey has no matching credential.\n");
			break;
		}
	}

out:
	OPENSSL_cleanse(pin, sizeof(pin));
	fido_assert_free(&assertion);
	free_blob(&client_hash);
	for (size_t i = 0; i < MAX_CREDENTIALS; i++)
		free_blob(&credential_ids[i]);
	free(client_hash_b64);
	free(credential_count_text);
	free(rp_id);
	return exit_code;
}
