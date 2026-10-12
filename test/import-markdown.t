use strict;
use warnings;
use utf8;
use Test::More;
use File::Temp qw(tempdir);
use File::Spec;
use FindBin;
use Encode qw(encode);
use Time::Local qw(timegm);
use POSIX qw(tzset);

require "$FindBin::Bin/../scripts/import-markdown.pl";

sub epoch { # Interpret the supplied test time as UTC.
    my ($year, $month, $day, $hour, $minute, $second) = @_;
    return timegm($second || 0, $minute || 0, $hour || 0, $day, $month - 1, $year);
}

sub name_for {
    return (Howm::MarkdownImport::output_name(@_))[2];
}

sub write_bytes {
    my ($path, $bytes) = @_;
    open my $file, '>:raw', $path or die "open $path: $!";
    print {$file} $bytes or die "write $path: $!";
    close $file or die "close $path: $!";
}

sub read_bytes {
    my ($path) = @_;
    open my $file, '<:raw', $path or die "open $path: $!";
    local $/;
    my $bytes = <$file>;
    close $file or die "close $path: $!";
    return defined $bytes ? $bytes : '';
}

subtest 'JST date matching, fallback and timezone independence' => sub {
    my $original_tz = $ENV{TZ};
    for my $tz ('UTC', 'America/Los_Angeles', 'Asia/Tokyo') {
        $ENV{TZ} = $tz;
        tzset();
        is(name_for('20261012-note.md', epoch(2026, 10, 12, 0, 30, 45)),
            '2026-10-12-093045.md', "matching ctime under $tz");
        is(name_for('20261012-note.md', epoch(2026, 10, 13, 0, 30, 45)),
            '2026-10-12-000000.md', "mismatching ctime under $tz");
        is(name_for('20261012-note.md', epoch(2026, 10, 11, 15, 0, 1)),
            '2026-10-12-000001.md', "UTC previous day, JST same day under $tz");
        is(name_for('20261011-note.md', epoch(2026, 10, 11, 15, 0, 1)),
            '2026-10-11-000000.md', "UTC same day, JST next day under $tz");
        is(name_for('20270101-note.md', epoch(2026, 12, 31, 15, 0, 0)),
            '2027-01-01-000000.md', "JST New Year midnight under $tz");
    }
    if (defined $original_tz) { $ENV{TZ} = $original_tz; } else { delete $ENV{TZ}; }
    tzset();
};

subtest 'filename and calendar validation' => sub {
    is_deeply([Howm::MarkdownImport::output_name('/source/20240229123456.txt', undef)],
        ['2024', '02', '2024-02-29-000000.md'], 'leading date determines folders regardless of original extension or time');
    is(name_for('20000229.md', undef), '2000-02-29-000000.md', 'leap century');
    is(name_for('00010101.md', undef), '0001-01-01-000000.md', 'four-digit early year');
    for my $name ('plain.md', '2026101.md', '20260229.md', '19000229.md', '20260431.md',
        '20260012.md', '20261301.md', '20261000.md', '20261032.md', '00001012.md') {
        eval { Howm::MarkdownImport::output_name($name, undef) };
        ok($@, "reject $name");
    }
};

subtest 'copy bytes, original ctime, collision protection and invalid input' => sub {
    my $root = tempdir(CLEANUP => 1);
    my $destination = File::Spec->catdir($root, 'output with spaces');
    my $source = File::Spec->catfile($root, '20000101-note.md');
    my $bytes = "\xEF\xBB\xBF" . encode('UTF-8', "# 買い物\r\n牛乳を買う\r\n# 読書\r\n本を読む\r\n");
    write_bytes($source, $bytes);
    my @source_stat = stat($source);
    my $first = Howm::MarkdownImport::copy_note($destination, $source);
    is($first, File::Spec->catfile($destination, '2000', '01', '2000-01-01-000000.md'), 'ctime mismatch uses zero time in YYYY/MM');
    is(read_bytes($first), $bytes, 'Japanese text, BOM and CRLF are byte-identical');
    is(read_bytes($source), $bytes, 'input file remains unchanged');
    is((stat($source))[10], $source_stat[10], 'input ctime is preserved');
    my $second = Howm::MarkdownImport::copy_note($destination, $source);
    like($second, qr/000000-1\.md\z/, 'first collision gets -1');
    my $third = Howm::MarkdownImport::copy_note($destination, $source);
    like($third, qr/000000-2\.md\z/, 'second collision gets -2');
    is(read_bytes($first), $bytes, 'existing output is never overwritten');

    my $protected = File::Spec->catfile($root, 'protected.md');
    write_bytes($protected, 'do not overwrite');
    my $next = File::Spec->catfile($destination, '2000', '01', '2000-01-01-000000-3.md');
    symlink $protected, $next or die "symlink: $!";
    like(Howm::MarkdownImport::copy_note($destination, $source), qr/000000-4\.md\z/, 'existing symlink is skipped');
    is(read_bytes($protected), 'do not overwrite', 'symlink target remains intact');

    my $invalid = File::Spec->catfile($root, '20000102-invalid.md');
    write_bytes($invalid, "\xFF");
    eval { Howm::MarkdownImport::copy_note($destination, $invalid) };
    ok($@, 'invalid UTF-8 fails before output creation');
    ok(!-e File::Spec->catfile($destination, '2000', '01', '2000-01-02-000000.md'), 'invalid input leaves no output');
    for my $bad ($root, File::Spec->catfile($root, 'missing.md')) {
        eval { Howm::MarkdownImport::copy_note($destination, $bad) };
        ok($@, 'reject a directory or missing file');
    }

    my @now = gmtime(time + 9 * 3600);
    my $today = sprintf('%04d%02d%02d', $now[5] + 1900, $now[4] + 1, $now[3]);
    my $current = File::Spec->catfile($root, "$today-current.md");
    write_bytes($current, '');
    my $ctime = (stat($current))[10];
    my ($year, $month, $filename) = Howm::MarkdownImport::output_name($current, $ctime);
    my $result = Howm::MarkdownImport::copy_note($destination, $current);
    is($result, File::Spec->catfile($destination, $year, $month, $filename), 'actual input ctime selects the output name');
    is(read_bytes($result), '', 'empty Markdown file can be copied');
};

subtest 'CLI arguments, partial failures and unusable destination' => sub {
    my $root = tempdir(CLEANUP => 1);
    my $source = File::Spec->catfile($root, '20000101.md');
    write_bytes($source, "# Note\n");
    my $destination = File::Spec->catdir($root, 'new output');
    my ($out, $err) = ('', '');
    {
        open my $stdout, '>', \$out or die $!;
        open my $stderr, '>', \$err or die $!;
        local *STDOUT = $stdout;
        local *STDERR = $stderr;
        is(Howm::MarkdownImport::main($destination, File::Spec->catfile($root, 'missing.md'), $source), 1, 'partial failure returns 1 and continues');
    }
    like($out, qr/Copied: 1; Failed: 1/, 'summary includes successful and failed counts');
    like($out, qr/2000-01-01-000000\.md/, 'output mapping is printed');
    like($err, qr/FAILED .*missing\.md:/, 'failure names the input');
    ok(-f File::Spec->catfile($destination, '2000', '01', '2000-01-01-000000.md'), 'valid input after an error is still copied');
    {
        open my $stdout, '>', \$out or die $!;
        open my $stderr, '>', \$err or die $!;
        local *STDOUT = $stdout;
        local *STDERR = $stderr;
        is(Howm::MarkdownImport::main(), 2, 'missing arguments return 2');
        is(Howm::MarkdownImport::main($destination), 2, 'missing inputs return 2');
        is(Howm::MarkdownImport::main('', $source), 2, 'empty destination returns 2');
        is(Howm::MarkdownImport::main('--help'), 0, '--help returns 0');
        my $blocked = File::Spec->catfile($root, 'not-a-directory');
        write_bytes($blocked, 'keep');
        is(Howm::MarkdownImport::main($blocked, $source), 1, 'failed destination creation returns 1');
        is(read_bytes($blocked), 'keep', 'invalid destination is unchanged');
    }
};

done_testing();
